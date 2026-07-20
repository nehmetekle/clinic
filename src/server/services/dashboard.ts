import { db } from "../db";
import { clinicDay, todayIso, toUsdFrozen } from "@/lib/config";
import { listAppointments } from "../repositories/appointments";
import { listClients } from "../repositories/clients";
import { listConsultations } from "../repositories/consultations";
import { listExpenses } from "../repositories/expenses";
import { listPayments } from "../repositories/payments";
import { getUsdToLbp } from "../repositories/settings";
import { listStaff } from "../repositories/staff";
import type {
  AppointmentStatus,
  DashboardSummary,
  RecentConsultation,
  Role,
} from "@/lib/types";

const STATUS_META: Record<AppointmentStatus, { name: string; color: string }> = {
  completed: { name: "Completed", color: "#16a34a" },
  checked_in: { name: "Checked-in", color: "#2563eb" },
  with_dietitian: { name: "With dietitian", color: "#7c3aed" },
  scheduled: { name: "Scheduled", color: "#64748b" },
  no_show: { name: "No-show", color: "#9f1239" },
  cancelled: { name: "Cancelled", color: "#e11d48" },
};

function lastSixMonths(today: string) {
  const base = new Date(`${today}T00:00:00Z`);
  const months: { key: string; label: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    months.push({
      key: dt.toISOString().slice(0, 7),
      label: dt.toLocaleString("en-US", { month: "short" }),
    });
  }
  return months;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return getDashboardSummaryForRole({ role: "admin", includeMedicalHistoryStatus: true });
}

export async function getDashboardSummaryForRole(
  opts: { role?: Role; includeMedicalHistoryStatus?: boolean; from?: string; to?: string } = {},
): Promise<DashboardSummary> {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [clients, payments, expenses, consultations, staff, todaysAppointments, outstandingDebts, soldPackages, usdToLbp] =
    await Promise.all([
      listClients(),
      listPayments(),
      listExpenses(),
      listConsultations(),
      listStaff(),
      listAppointments(today, {
        includeMedicalHistoryStatus: opts.includeMedicalHistoryStatus,
      }),
      db.clientDebt.findMany({ where: { status: "outstanding" } }),
      // COGS source: frozen ClientPackage.cost snapshots. Read straight from the
      // DB (the client mapper strips `cost`); `startDate` is the sale date used to
      // window this flow figure. ClientPackage carries no usdToLbp snapshot, so
      // LBP costs fall back to the live rate like any legacy row (sales are USD today).
      db.clientPackage.findMany({ select: { cost: true, currency: true, startDate: true } }),
      getUsdToLbp(),
    ]);

  // All financial figures below are aggregated in USD. Each record is converted
  // using the exchange rate FROZEN on it when it was logged — never today's rate
  // — so historical totals never shift when the live rate changes. Only legacy
  // rows with no snapshot (usdToLbp = 0) fall back to the current rate.
  const conv = (amount: number, currency: string, rate: number) =>
    toUsdFrozen(amount, currency, rate, usdToLbp);

  // Period window for the FLOW figures (income, expenses, net profit). Every cost
  // is a real dated Expense row now (fixed-cost accrual was removed), so a period
  // total is simply the rows whose date falls in [from, to]. Absent bounds mean
  // all-time. Snapshot figures (counts, outstanding debts, today's activity) are
  // NOT affected by the window.
  const inRange = (date: string) =>
    (!opts.from || date >= opts.from) && (!opts.to || date <= opts.to);

  // Counts
  const counts = {
    totalClients: clients.length,
    activeClients: clients.filter((c) => c.active).length,
    newToday: clients.filter((c) => c.registeredAt === today).length,
    newThisMonth: clients.filter((c) => c.registeredAt >= monthStart).length,
    consultations: consultations.length,
  };

  // Finance — income and expenses summed over the selected window.
  const totalIncome = payments
    .filter((p) => inRange(p.date))
    .reduce((s, p) => s + conv(p.amountPaid, p.currency, p.usdToLbp), 0);
  const totalExpenses = expenses
    .filter((e) => inRange(e.date))
    .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0);
  // Money owed = outstanding tracked debts only (current snapshot, not windowed).
  const unpaidBalance = outstandingDebts.reduce((s, d) => s + conv(d.amount, d.currency, d.usdToLbp), 0);
  const paymentsToday = payments
    .filter((p) => p.date === today)
    .reduce((s, p) => s + conv(p.amountPaid, p.currency, p.usdToLbp), 0);
  // Cost of goods sold: frozen package cost for sales whose startDate falls in the
  // window (same flow-figure treatment as income/expenses). ClientPackage has no
  // rate snapshot, so conv() uses the live rate for LBP costs.
  const cogs = soldPackages
    .filter((cp) => inRange(clinicDay(cp.startDate)))
    .reduce((s, cp) => s + conv(cp.cost, cp.currency, 0), 0);
  const finance = {
    totalIncome,
    totalExpenses,
    // Net profit is deliberately income − operating expenses only (COGS excluded);
    // gross margin is the separate figure that folds COGS in.
    netProfit: totalIncome - totalExpenses,
    cogs,
    grossMargin: totalIncome - (totalExpenses + cogs),
    unpaidBalance,
    paymentsToday,
  };

  // Packages
  const clientPackages = clients.flatMap((c) => c.packages);
  const packagesSold = clientPackages.length;
  const packageCounts = clientPackages.reduce<Record<string, number>>((acc, p) => {
    acc[p.packageName] = (acc[p.packageName] ?? 0) + 1;
    return acc;
  }, {});
  const mostPopularPackage =
    Object.entries(packageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  // Recent consultations with weight delta vs the prior visit.
  const weightByVisit = new Map<string, number | undefined>();
  for (const c of consultations) {
    weightByVisit.set(`${c.clientId}:${c.visitNumber}`, c.weightKg);
  }
  const recentConsultations: RecentConsultation[] = consultations
    .slice(0, 6)
    .map((c) => {
      const prev = weightByVisit.get(`${c.clientId}:${c.visitNumber - 1}`);
      const deltaKg =
        prev !== undefined && c.weightKg !== undefined
          ? Math.round((c.weightKg - prev) * 10) / 10
          : undefined;
      return {
        id: c.id,
        clientId: c.clientId,
        clientName: c.clientName,
        dietitianName: c.dietitianName,
        date: c.date,
        visitNumber: c.visitNumber,
        weightKg: c.weightKg,
        deltaKg,
      };
    });

  // Staff activity
  const staffActivity = staff
    .filter((s) => s.role === "dietitian")
    .map((s) => ({
      name: s.fullName,
      role: s.role,
      consults: consultations.filter((c) => c.dietitianName === s.fullName).length,
    }));

  // Income vs expenses series — a fixed last-6-months trend (not affected by the
  // period window). Every cost is a dated Expense row, so each month is just the
  // income and expenses dated within it.
  const incomeExpenseSeries = lastSixMonths(today).map((m) => ({
    month: m.label,
    income: payments
      .filter((p) => p.date.startsWith(m.key))
      .reduce((s, p) => s + conv(p.amountPaid, p.currency, p.usdToLbp), 0),
    expenses: expenses
      .filter((e) => e.date.startsWith(m.key))
      .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0),
  }));

  // Revenue by motif (bundle sales land here under their motif too).
  const revenueByPackage = payments.reduce<Record<string, number>>((acc, p) => {
    const name = p.motif;
    acc[name] = (acc[name] ?? 0) + conv(p.amountPaid, p.currency, p.usdToLbp);
    return acc;
  }, {});
  const packageRevenue = Object.entries(revenueByPackage)
    .map(([name, revenue]) => ({ name: name.replace(/ (Program|Session|Nutrition Plan)$/, ""), revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Appointment breakdown (today)
  const breakdownCounts = todaysAppointments.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const appointmentBreakdown = (Object.keys(breakdownCounts) as AppointmentStatus[]).map(
    (status) => ({
      name: STATUS_META[status].name,
      value: breakdownCounts[status],
      color: STATUS_META[status].color,
    }),
  );

  // Per-client outstanding debt (the money-owed figure; `balance` field kept for
  // the response shape but now holds tracked debt, not a payment remainder).
  const debtByClient = new Map<string, number>();
  for (const d of outstandingDebts) {
    debtByClient.set(
      d.clientId,
      (debtByClient.get(d.clientId) ?? 0) + conv(d.amount, d.currency, d.usdToLbp),
    );
  }
  const unpaidClients = clients
    .map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`,
      balance: debtByClient.get(c.id) ?? 0,
    }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  // Referrer report — patients grouped by the external referrer who sent them,
  // windowed by registration date. referralSource is a FROZEN name snapshot taken
  // when the client was registered/checked in (free text, NOT a live FK to the
  // Referrer table), so a referrer later renamed, deactivated or deleted still
  // shows here under the exact name recorded at the time — past counts never
  // shift. Clients with no referrer recorded fall into a "Not specified" bucket.
  const NOT_SPECIFIED = "Not specified";
  const referrerGroups = new Map<string, { id: string; name: string }[]>();
  for (const c of clients) {
    if (!inRange(c.registeredAt)) continue;
    const name = c.referralSource?.trim() || NOT_SPECIFIED;
    const roster = referrerGroups.get(name) ?? [];
    roster.push({ id: c.id, name: `${c.firstName} ${c.lastName}` });
    referrerGroups.set(name, roster);
  }
  const referrerReport = [...referrerGroups.entries()]
    .map(([name, patients]) => ({
      name,
      count: patients.length,
      patients: patients.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      // Pin the "Not specified" bucket last; otherwise most patients first, ties by name.
      if (a.name === NOT_SPECIFIED) return 1;
      if (b.name === NOT_SPECIFIED) return -1;
      return b.count - a.count || a.name.localeCompare(b.name);
    });

  const recentPayments = payments.slice(0, 5);

  const summary: DashboardSummary = {
    today,
    counts,
    finance,
    packagesSold,
    mostPopularPackage,
    todaysAppointments,
    recentPayments,
    recentConsultations,
    staffActivity,
    incomeExpenseSeries,
    packageRevenue,
    appointmentBreakdown,
    unpaidClients,
    referrerReport,
  };

  return redactForRole(summary, opts.role);
}

// "View financial reports (income/profit)" is admin-only (docs/01-product-spec.md
// §2.1) — the dashboard endpoint is shared by every role, so the aggregate
// report figures are zeroed out here (server-side) rather than trusted to the
// client UI to simply not render them. `paymentsToday`/`recentPayments` are
// day-to-day front-desk operations, not "reports" — kept for whichever role
// actually handles money (secretary, per the permission matrix; a dietitian
// never records payments, so loses these too).
function redactForRole(summary: DashboardSummary, role: Role | undefined): DashboardSummary {
  if (role === "admin") return summary;
  const canHandleMoney = role === "secretary";
  return {
    ...summary,
    finance: {
      ...summary.finance,
      totalIncome: 0,
      totalExpenses: 0,
      netProfit: 0,
      cogs: 0,
      grossMargin: 0,
      unpaidBalance: 0,
      paymentsToday: canHandleMoney ? summary.finance.paymentsToday : 0,
    },
    recentPayments: canHandleMoney ? summary.recentPayments : [],
    packagesSold: 0,
    mostPopularPackage: "",
    packageRevenue: [],
    incomeExpenseSeries: [],
    appointmentBreakdown: [],
    staffActivity: [],
    referrerReport: [],
    unpaidClients: [],
  };
}
