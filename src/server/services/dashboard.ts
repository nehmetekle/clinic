import { db } from "../db";
import { clinicDay, todayIso, toUsdFrozen } from "@/lib/config";
import { listAppointments } from "../repositories/appointments";
import { listClients } from "../repositories/clients";
import { listConsultations } from "../repositories/consultations";
import { listMachineVisits, machineUtilization } from "../repositories/machineVisits";
import { listExpenses } from "../repositories/expenses";
import { getJessyOutstanding } from "../repositories/jessy";
import { listPayments } from "../repositories/payments";
import { getUsdToLbp } from "../repositories/settings";
import { debtOutstandingUsd } from "../repositories/clientDebts";
import { listStaff } from "../repositories/staff";
import type {
  AppointmentStatus,
  DashboardSummary,
  RecentConsultation,
  Role,
  TenderBreakdownEntry,
} from "@/lib/types";

const STATUS_META: Record<AppointmentStatus, { name: string; color: string }> = {
  completed: { name: "Completed", color: "#16a34a" },
  checked_in: { name: "Checked-in", color: "#2563eb" },
  with_dietitian: { name: "With doctor", color: "#7c3aed" },
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

  const [clients, payments, expenses, consultations, staff, todaysAppointments, outstandingDebts, referralClients, soldPackages, usdToLbp, jessyOutstanding, allMachineVisits, machineUsage] =
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
      // Referrer-cost source: the frozen per-patient commission (USD). Read straight
      // from the DB (the client mapper strips `referralFee` — it's an admin-only
      // cost), windowed by registration date since the fee is a one-time cost
      // incurred when the patient is attributed to a referrer at registration.
      db.client.findMany({
        where: { referralFee: { not: null } },
        select: { id: true, firstName: true, lastName: true, referralFee: true, referralSource: true, registeredAt: true },
      }),
      // COGS source: frozen ClientPackage.cost snapshots. Read straight from the
      // DB (the client mapper strips `cost`); `startDate` is the sale date used to
      // window this flow figure. ClientPackage carries no usdToLbp snapshot, so
      // LBP costs fall back to the live rate like any legacy row (sales are USD today).
      db.clientPackage.findMany({ select: { cost: true, currency: true, startDate: true } }),
      getUsdToLbp(),
      // What the third-party payer Jessy still owes the clinic (USD). A BALANCE,
      // not a flow — never windowed by the period, and deliberately not part of
      // any income figure: the money it represents was already counted as income
      // when the patient paid through Jessy. See repositories/jessy.ts.
      getJessyOutstanding(),
      // Machine-only visits: attendance and prepaid-session consumption that is
      // deliberately NOT a consultation. Counted separately everywhere below —
      // it must never move the consultation figures.
      listMachineVisits({}),
      machineUtilization({ from: opts.from, to: opts.to }),
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

  // Voided machine visits never happened — they are excluded from every figure
  // here, exactly like the sessions they gave back.
  const machineVisitsRecorded = allMachineVisits.filter((v) => v.status === "recorded");

  // Counts
  const counts = {
    totalClients: clients.length,
    activeClients: clients.filter((c) => c.active).length,
    newToday: clients.filter((c) => c.registeredAt === today).length,
    newThisMonth: clients.filter((c) => c.registeredAt >= monthStart).length,
    consultations: consultations.length,
    // Attendance that produced no consultation. A separate figure on purpose:
    // adding it to `consultations` would report visits that never happened.
    machineVisits: machineVisitsRecorded.length,
  };

  // Finance — income and expenses summed over the selected window.
  // `amountUsd` is computed by the payment serializer at each row's OWN frozen
  // rate (see repositories/payments.ts) — the single place FX is applied to money
  // the clinic has collected, so a EUR/LBP leg lands here already valued and
  // today's rate can never re-price it.
  const totalIncome = payments
    .filter((p) => inRange(p.date))
    .reduce((s, p) => s + p.amountUsd, 0);
  const totalExpenses = expenses
    .filter((e) => inRange(e.date))
    .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0);
  // Money owed = outstanding tracked debts only (current snapshot, not windowed).
  // The still-OWED part of each debt: a partly-collected debt must not report its
  // full principal as money the clinic is still waiting for.
  const unpaidBalance = outstandingDebts.reduce((s, d) => s + debtOutstandingUsd(d), 0);
  const paymentsToday = payments
    .filter((p) => p.date === today)
    .reduce((s, p) => s + p.amountUsd, 0);
  // Payment-method splits (USD) behind the collected-money figures. Same frozen-rate
  // conversion as the totals they mirror, so a method row always sums to its parent.
  // Keyed by the RAW method value stored on each record (trimmed) — NEVER folded
  // into another method — so a method later removed from the offered choices still
  // reports under its own original value. Blank/garbled values collapse to the "" key
  // (rendered as "Other"); everything non-empty is preserved verbatim.
  const sumByMethod = (rows: typeof payments) => {
    const acc: Record<string, number> = {};
    for (const p of rows) {
      const key = (p.method ?? "").trim();
      acc[key] = (acc[key] ?? 0) + p.amountUsd;
    }
    return acc;
  };
  // Same money, split by method AND tender currency. The NATIVE totals are kept
  // alongside the USD ones so the drawer can actually be counted — normalising
  // everything to USD at this point would destroy the only figure the person
  // counting notes and coins can check against.
  const sumByTender = (rows: typeof payments): TenderBreakdownEntry[] => {
    const acc = new Map<string, TenderBreakdownEntry>();
    for (const p of rows) {
      const method = (p.method ?? "").trim();
      const key = `${method}|${p.currency}`;
      const prev = acc.get(key);
      acc.set(key, {
        method,
        currency: p.currency,
        usd: (prev?.usd ?? 0) + p.amountUsd,
        native: (prev?.native ?? 0) + p.amountPaid,
      });
    }
    return [...acc.values()].map((e) => ({
      ...e,
      usd: Math.round(e.usd * 100) / 100,
      native: Math.round(e.native * 100) / 100,
    }));
  };
  const windowed = payments.filter((p) => inRange(p.date));
  const todays = payments.filter((p) => p.date === today);
  const incomeByMethod = sumByMethod(windowed);
  const paymentsTodayByMethod = sumByMethod(todays);
  const incomeByTender = sumByTender(windowed);
  const paymentsTodayByTender = sumByTender(todays);
  // Cost of goods sold: frozen package cost for sales whose startDate falls in the
  // window (same flow-figure treatment as income/expenses). ClientPackage has no
  // rate snapshot, so conv() uses the live rate for LBP costs.
  const cogs = soldPackages
    .filter((cp) => inRange(clinicDay(cp.startDate)))
    .reduce((s, cp) => s + conv(cp.cost, cp.currency, 0), 0);
  // Referrer cost: frozen per-patient commissions for patients registered in the
  // window (a real clinic cost, in USD). referralFee is always USD, so no rate
  // conversion is needed. Dated by registration since the fee is incurred once,
  // when the referrer is attributed to the patient at registration/check-in.
  const referrerCost = referralClients
    .filter((c) => inRange(clinicDay(c.registeredAt)))
    .reduce((s, c) => s + (c.referralFee ?? 0), 0);
  const finance = {
    totalIncome,
    totalExpenses,
    // Net profit is income − operating expenses − referrer cost (COGS excluded, by
    // design); gross margin is the separate figure that also folds COGS in.
    netProfit: totalIncome - totalExpenses - referrerCost,
    cogs,
    grossMargin: totalIncome - (totalExpenses + cogs + referrerCost),
    referrerCost,
    unpaidBalance,
    jessyOutstanding,
    paymentsToday,
    incomeByMethod,
    paymentsTodayByMethod,
    incomeByTender,
    paymentsTodayByTender,
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
      // Kept out of `consults` so a doctor's consultation productivity stays a
      // count of consultations.
      machineVisits: machineVisitsRecorded.filter((v) => v.recordedByName === s.fullName).length,
    }));

  // Income vs expenses series — a fixed last-6-months trend (not affected by the
  // period window). Every cost is a dated Expense row, so each month is just the
  // income and expenses dated within it.
  const incomeExpenseSeries = lastSixMonths(today).map((m) => ({
    month: m.label,
    income: payments
      .filter((p) => p.date.startsWith(m.key))
      .reduce((s, p) => s + p.amountUsd, 0),
    expenses: expenses
      .filter((e) => e.date.startsWith(m.key))
      .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0),
  }));

  // Revenue by motif (bundle sales land here under their motif too).
  const revenueByPackage = payments.reduce<Record<string, number>>((acc, p) => {
    const name = p.motif;
    acc[name] = (acc[name] ?? 0) + p.amountUsd;
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
      (debtByClient.get(d.clientId) ?? 0) + debtOutstandingUsd(d),
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

  // Referrer-cost breakdown — the same registration-windowed patients as
  // `referrerCost`, grouped by the FROZEN referrer name they were attributed to,
  // with the total commission owed and the patients behind it. Only referrers who
  // are actually owed money (referralFee frozen) appear here; the drill-down opens
  // from the "Referrer cost" figure on the dashboard/reports.
  const costGroups = new Map<string, { id: string; name: string; fee: number }[]>();
  for (const c of referralClients) {
    if (!inRange(clinicDay(c.registeredAt))) continue;
    const fee = c.referralFee ?? 0;
    if (fee <= 0) continue;
    const name = c.referralSource?.trim() || NOT_SPECIFIED;
    const roster = costGroups.get(name) ?? [];
    roster.push({ id: c.id, name: `${c.firstName} ${c.lastName}`, fee });
    costGroups.set(name, roster);
  }
  const referrerCostReport = [...costGroups.entries()]
    .map(([name, patients]) => ({
      name,
      total: patients.reduce((s, p) => s + p.fee, 0),
      patients: patients.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

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
    referrerCostReport,
    machineUtilization: machineUsage,
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
      referrerCost: 0,
      unpaidBalance: 0,
      // A receivable ledger figure — reports territory, so admin-only like the
      // totals above.
      jessyOutstanding: 0,
      paymentsToday: canHandleMoney ? summary.finance.paymentsToday : 0,
      // Method splits follow their parent totals: totalIncome is admin-only (zeroed
      // above), so incomeByMethod is always emptied here; paymentsToday is kept for
      // whoever handles money, so its split rides along.
      incomeByMethod: {},
      paymentsTodayByMethod: canHandleMoney ? summary.finance.paymentsTodayByMethod : {},
      // The tender (method × currency) splits are the same money as the two maps
      // above, so they MUST follow the same redaction — otherwise a non-admin could
      // reconstruct the admin-only income total by summing this array.
      incomeByTender: [],
      paymentsTodayByTender: canHandleMoney ? summary.finance.paymentsTodayByTender : [],
    },
    recentPayments: canHandleMoney ? summary.recentPayments : [],
    packagesSold: 0,
    mostPopularPackage: "",
    packageRevenue: [],
    incomeExpenseSeries: [],
    appointmentBreakdown: [],
    staffActivity: [],
    referrerReport: [],
    referrerCostReport: [],
    unpaidClients: [],
  };
}
