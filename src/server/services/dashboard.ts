import { db } from "../db";
import { clinicDay, NONE_REFERRER, todayIso, toUsdFrozen } from "@/lib/config";
import { listAppointments } from "../repositories/appointments";
import { listClients } from "../repositories/clients";
import { listConsultations } from "../repositories/consultations";
import { topBloodTests } from "../repositories/bloodSamples";
import { listMachineVisits, machineUtilization } from "../repositories/machineVisits";
import { listExpenses } from "../repositories/expenses";
import { getJessyOutstanding } from "../repositories/jessy";
import { listPayments } from "../repositories/payments";
import { getUsdToLbp } from "../repositories/settings";
import { debtOutstandingUsd } from "../repositories/clientDebts";
import {
  getProfitability,
  getMonthlyProfitability,
  getBundleProfitability,
  getExternalLabProfitability,
} from "../repositories/profitability";
import { getReferralSummary } from "../repositories/referralCommissions";
import { listStaff } from "../repositories/staff";
import { JESSY_METHOD, NO_MACHINE_LABEL } from "@/lib/types";
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
      // `dt` is UTC midnight on the 1st. Without an explicit timeZone this
      // formats in the RUNTIME's zone, so any host west of UTC renders the
      // PREVIOUS month's name — the data stays right and only the axis lies,
      // which is the hardest version of this bug to notice. Pinned to UTC to
      // match the key it labels.
      label: dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    });
  }
  return months;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return getDashboardSummaryForRole({ role: "admin", includeMedicalHistoryStatus: true });
}

export async function getDashboardSummaryForRole(
  opts: {
    role?: Role;
    includeMedicalHistoryStatus?: boolean;
    from?: string;
    to?: string;
    // Scopes the EARNED figures to one dietitian's visits. Clinic-wide costs
    // (operating expenses, referrer commissions) and the cash balances are never
    // scoped by it — see ProfitabilityRange — so there is no per-dietitian net
    // profit here, and the UI hides that block rather than showing a figure that
    // charges one person with the whole clinic's overheads.
    dietitianId?: string;
  } = {},
): Promise<DashboardSummary> {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [clients, payments, expenses, consultations, staff, todaysAppointments, outstandingDebts, referralCommissions, usdToLbp, jessyOutstanding, allMachineVisits, machineUsage, topBloodTestsOrdered, profitability, referralSummary, monthlyProfit, bundleProfit, externalLabProfit, referralPayouts, jessySettlements] =
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
      // Referrer-cost source: the COMMISSION LEDGER. A commission exists only
      // where the clinic actually became liable — the patient's first completed
      // visit — so a patient who registered and never attended contributes
      // nothing. Windowed by `incurredAt`, the date the obligation was created.
      // Voided (written-off) commissions are excluded: they are no longer owed.
      db.referralCommission.findMany({
        where: { status: { not: "void" } },
        select: {
          id: true,
          amount: true,
          incurredAt: true,
          // Frozen at the moment the commission was incurred — never a join to
          // the live Referrer, so a rename or deletion cannot restate history.
          referrerNameSnapshot: true,
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
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
      // Lab volume for the same window: which blood tests were ordered most. A
      // count of orders, never money, so it passes through for every role.
      topBloodTests({ from: opts.from, to: opts.to }),
      // EARNED revenue and its COGS for the window, from the frozen figures on
      // settled basket lines. Deliberately independent of what was collected.
      getProfitability({ from: opts.from, to: opts.to, dietitianId: opts.dietitianId }),
      // What is still owed TO referrers. A balance, so it is never windowed.
      getReferralSummary(),
      // Earned revenue and COGS per clinic month for the trend chart. Bucketed by
      // the same clinicDay() the headline window uses and summed by the same
      // shared core, so a month on the chart and that month selected as the period
      // are the same number rather than two derivations of it.
      getMonthlyProfitability(
        `${lastSixMonths(today)[0].key}-01`,
        today,
        opts.dietitianId,
      ),
      // Per-bundle revenue/COGS/margin for the SAME window as the headline cards,
      // from the same settled lines — see getBundleProfitability.
      getBundleProfitability({ from: opts.from, to: opts.to, dietitianId: opts.dietitianId }),
      // External-lab blood collection: revenue, the lab's own charge, and the
      // margin — per order and in total, for the SAME window and from the SAME
      // settled lines the revenue breakdown counts under `external_lab`. This is
      // the only place the clinic can see whether an outsourced panel made money,
      // because the lab re-quotes the same tests differently every time.
      getExternalLabProfitability({ from: opts.from, to: opts.to, dietitianId: opts.dietitianId }),
      // CASH going OUT to referrers. Dated by `paidAt` — when the money actually
      // left — which is a different question from `incurredAt` above and must
      // never be confused with it: the commission was the expense, this is the
      // cash movement that settles it. Only the cash-on-hand block reads this.
      db.referralPayout.findMany({ select: { amount: true, paidAt: true } }),
      // CASH coming IN from Jessy. A settlement writes no Payment (the income was
      // recognized when the patient paid through Jessy), so it is invisible to
      // every income figure — which is exactly why the cash block has to read it
      // directly. USD only, by design: the Jessy ledger is single-currency.
      db.jessySettlement.findMany({ select: { amount: true, createdAt: true } }),
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
  // OPERATING expenses only. A referral commission entered here by hand is
  // excluded, because the commission ledger already recognized it as an expense
  // when it was incurred — counting the row too would double it. Referral payouts
  // never create an Expense at all; this filter is the safety net for manual entry.
  const operatingExpenses = expenses.filter((e) => e.kind === "operating");
  const totalExpenses = operatingExpenses
    .filter((e) => inRange(e.date))
    .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0);
  // Money owed = outstanding tracked debts only (current snapshot, not windowed).
  // The still-OWED part of each debt: a partly-collected debt must not report its
  // full principal as money the clinic is still waiting for.
  const unpaidBalance = outstandingDebts.reduce((s, d) => s + debtOutstandingUsd(d, usdToLbp), 0);
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
  // NOTE: COGS is no longer derived from ClientPackage here. It now comes from the
  // frozen `unitCost` on each settled basket line (getProfitability), which is the
  // single source for both sides of a sale — the same row supplies the revenue and
  // the cost, so the two can never be windowed differently or counted twice. A
  // package's cost reaches the P&L through its own basket line, once, at purchase.
  // Referrer cost: commissions INCURRED in the window (always USD, so no rate
  // conversion). This is an operating expense recognized exactly once, when the
  // obligation was created. Paying it later is a cash movement and is deliberately
  // NOT read here — recognizing a payout as an expense would count the same money
  // a second time.
  const referrerCost = referralCommissions
    .filter((c) => inRange(clinicDay(c.incurredAt)))
    .reduce((s, c) => s + c.amount, 0);
  // Net profit, defined ONCE. Both the headline card and every month of the trend
  // chart call this, so the two agree to the cent instead of agreeing to within a
  // rounding step: rounding `cogs + opex + commissions` first and then subtracting
  // gives a different last cent than subtracting each term separately, and a chart
  // that disagrees with its own card by a penny is a chart nobody trusts.
  const netProfitOf = (revenue: number, cogs: number, opex: number, commissions: number) => {
    const totalCosts = Math.round((cogs + opex + commissions) * 100) / 100;
    return {
      totalCosts,
      netProfit: Math.round((revenue - totalCosts) * 100) / 100,
    };
  };
  const headline = netProfitOf(
    profitability.revenue,
    profitability.cogs,
    totalExpenses,
    referrerCost,
  );

  // ---- CASH ON HAND -------------------------------------------------------
  // The owner's other question, answered on its own terms: not "did we earn
  // well" but "how much money did this month actually put in my pocket".
  //
  //   netCash = collected − operating expenses paid − referrer payouts
  //
  // Every term is a REAL MOVEMENT OF MONEY dated when it moved, which is why this
  // block shares only `totalIncome` with the accrual figures above and derives
  // nothing from revenue, COGS or net profit:
  //  - COGS is deliberately absent. Stock was paid for when it was bought, and
  //    that purchase is an Expense row; subtracting COGS here would charge the
  //    same money twice, once as the expense and once as the cost of the sale.
  //  - A sale on credit contributes NOTHING until the debt is collected, and
  //    collecting an old debt counts here in full even though it is revenue from
  //    a period long closed. That is the entire point of the figure.
  //  - Referrer cash uses `paidAt`, never `incurredAt`. The commission is an
  //    expense when incurred (see `referrerCost`); it is cash when it is paid.
  const referrerPayouts = referralPayouts
    .filter((p) => inRange(clinicDay(p.paidAt)))
    .reduce((s, p) => s + p.amount, 0);
  // Jessy is the one place income and cash genuinely happen on different days, so
  // the cash block re-times it and NOTHING else does:
  //  - a `jessy` Payment is income today but no money in the till, so it comes OUT
  //    of the cash figure even though it stays in `totalIncome`;
  //  - a settlement is money actually transferred and writes no Payment at all,
  //    so it goes IN, dated when it arrived.
  // Over any window wide enough to contain both, the two cancel exactly — which is
  // the same `recorded − settled === outstanding` identity the Jessy tests assert.
  const jessyIncome = payments
    .filter((p) => p.method === JESSY_METHOD && inRange(p.date))
    .reduce((s, p) => s + p.amountUsd, 0);
  const jessyReceived = jessySettlements
    .filter((t) => inRange(clinicDay(t.createdAt)))
    .reduce((s, t) => s + t.amount, 0);
  const cashCollected = Math.round((totalIncome - jessyIncome + jessyReceived) * 100) / 100;
  const cashOut = Math.round((totalExpenses + referrerPayouts) * 100) / 100;
  const netCash = Math.round((cashCollected - cashOut) * 100) / 100;

  const finance = {
    // ---- EARNED / PROFITABILITY ----------------------------------------------
    // Revenue, COGS and gross profit come from the FROZEN figures on settled
    // basket lines, dated when the sale was finalized. A prepaid package or plan
    // is recognized in full at purchase; later use of those sessions recognizes
    // nothing. See repositories/profitability.ts.
    revenue: profitability.revenue,
    grossRevenue: profitability.grossRevenue,
    discounts: profitability.discounts,
    cogs: profitability.cogs,
    grossProfit: profitability.grossProfit,
    grossMarginPercent: profitability.grossMarginPercent,
    revenueByKind: profitability.byKind,
    operatingExpenses: totalExpenses,
    referrerCost,
    // The hierarchy, stated once:
    //   revenue − cogs                        = gross profit
    //   gross profit − opex − referrer cost   = net profit
    // Referral commissions are a selling cost, not a cost of goods, so they sit
    // below the gross-profit line with the other operating expenses.
    netProfit: headline.netProfit,

    // ---- CASH / COLLECTION ---------------------------------------------------
    // What was COLLECTED. Deliberately not part of any figure above: a sale on
    // credit is revenue today and cash later, and collecting an old debt is cash
    // today and revenue never (it was recognized when the sale was made).
    totalIncome,
    unpaidBalance,
    jessyOutstanding,
    // Owed TO referrers — a balance, never windowed, and never an expense again
    // (it was recognized when each commission was incurred).
    referralOutstanding: referralSummary.outstanding,
    // ---- CASH ON HAND --------------------------------------------------------
    // Collected minus what was actually paid out, both dated by the movement of
    // money. See the derivation above; `totalIncome` and `operatingExpenses` are
    // the same numbers reported elsewhere on this object, not re-derived ones.
    referrerPayouts: Math.round(referrerPayouts * 100) / 100,
    jessyIncome: Math.round(jessyIncome * 100) / 100,
    jessyReceived: Math.round(jessyReceived * 100) / 100,
    cashCollected,
    cashOut,
    netCash,
    paymentsToday,
    incomeByMethod,
    paymentsTodayByMethod,
    incomeByTender,
    paymentsTodayByTender,
  };

  // Bundles sold, from the SALES — the settled `package` basket lines — not from
  // the ClientPackage table.
  //
  // Counting ClientPackage rows counted every bundle row that had ever been
  // created, over all time regardless of the selected period, including the
  // orphans an abandoned consultation draft leaves behind: rows that were never
  // sold to anyone. A basket line exists only where a bundle was actually
  // charged on a finalized bill, so it is both windowed and orphan-free by
  // construction, with no cleanup job to keep running.
  const packagesSold = bundleProfit.reduce((n, b) => n + b.sales, 0);
  const mostPopularPackage =
    [...bundleProfit].sort((a, b) => b.sales - a.sales || b.revenue - a.revenue)[0]?.name ?? "—";

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

  // Profit trend — a fixed last-6-months view (not affected by the period window,
  // which the card says). Every series here is EARNED, never collected: revenue is
  // finalized sales, and costs are what those sales and the month's running of the
  // clinic actually cost. Payments appear nowhere — cash lives in its own section.
  //
  //   totalCosts = COGS + operating expenses + referrer commissions incurred
  //   netProfit  = revenue − totalCosts
  //
  // which is exactly the headline arithmetic (grossProfit − opex − referrerCost),
  // so selecting a month as the period reproduces that month's bar rather than a
  // near-miss. Month membership uses clinic-day strings on every series.
  const scopedToDietitian = opts.dietitianId !== undefined && opts.dietitianId !== "";
  const profitSeries = lastSixMonths(today).map((m) => {
    const p = monthlyProfit.get(m.key);
    const revenue = p?.revenue ?? 0;
    const cogs = p?.cogs ?? 0;
    // Scoped to one dietitian, the clinic-wide costs are deliberately left out:
    // the revenue in this series is one person's, and charging it with the whole
    // clinic's rent would draw a loss line that means nothing. The series then
    // reads Revenue / COGS / GROSS profit, which the card subtitle states.
    const opex = scopedToDietitian
      ? 0
      : operatingExpenses
          .filter((e) => e.date.startsWith(m.key))
          .reduce((s, e) => s + conv(e.amount, e.currency, e.usdToLbp), 0);
    const commissions = scopedToDietitian
      ? 0
      : referralCommissions
          .filter((c) => clinicDay(c.incurredAt).startsWith(m.key))
          .reduce((s, c) => s + c.amount, 0);
    // Same function as the headline card — see netProfitOf.
    const { totalCosts, netProfit } = netProfitOf(revenue, cogs, opex, commissions);
    return { month: m.label, revenue, costs: totalCosts, netProfit };
  });

  // The bundles that actually made the clinic money, from the finalized package
  // sales themselves — NOT from payment motifs, which are free text a secretary
  // types and which group nothing reliably. Ranked by gross profit, because the
  // question the card answers is "most profitable", not "largest turnover": a
  // high-revenue bundle sold near cost is not the one to push. Windowed by the
  // selected period like every other earned figure, and reconciling exactly to
  // the `package` row of the revenue breakdown.
  const packageRevenue = bundleProfit.slice(0, 5);

  // The machines the clinic actually leaned on this period, ranked by SESSIONS —
  // not by visit count, since one visit can deliver several sessions and ranking
  // by visits would understate a machine used heavily in long appointments.
  //
  // Sliced straight off the machine-utilization rows rather than re-derived, so
  // the chart and the table beneath it cannot disagree: same period, same
  // clinic-day boundaries, same canonical catalog machine identity, and the same
  // combination of consultation and machine-visit usage.
  //
  // The "no machine" bucket is excluded — it is real usage but it is not a
  // machine, so it has no place in a ranking of machines. It stays visible in the
  // utilization table, which is where the totals have to add up.
  const topMachines = machineUsage
    .filter((m) => m.machine !== NO_MACHINE_LABEL)
    .slice(0, 5)
    .map((m) => ({ machine: m.machine, sessions: m.sessions, machineVisits: m.machineVisits }));

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
      (debtByClient.get(d.clientId) ?? 0) + debtOutstandingUsd(d, usdToLbp),
    );
  }
  // Built from the DEBTS, not from the client list, so the rows sum to the
  // "Owed by clients" card by construction. Driving it from `clients` instead
  // means a debt whose client is missing from that list is money the card counts
  // and the table cannot show — a total that silently disagrees with the rows
  // under it, which is the one thing a debt report must never do. The client list
  // supplies names only; a debt whose client cannot be named is still reported,
  // labelled as such, rather than dropped.
  const clientNames = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`]));
  const unpaidClients = [...debtByClient.entries()]
    .filter(([, balance]) => balance > 0)
    .map(([id, balance]) => ({ id, name: clientNames.get(id) ?? "Unknown client", balance }))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));

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
      // Two buckets are pinned to the bottom, not ranked: "Not specified" (no
      // answer recorded) and the reserved NONE_REFERRER choice, which means the
      // patient came organically. NONE_REFERRER is a real stored value, so it
      // used to sort by count among the referrers and could top the table as
      // though "None" were the clinic's best referral source. It is the absence
      // of one.
      const rank = (name: string) =>
        name === NOT_SPECIFIED ? 2 : name === NONE_REFERRER ? 1 : 0;
      return (
        rank(a.name) - rank(b.name) ||
        b.count - a.count ||
        a.name.localeCompare(b.name)
      );
    });

  // Referrer-cost breakdown — the commissions INCURRED in the window, grouped by
  // the referrer name frozen onto each one, with the patient whose first visit
  // created it. Nothing here is derived from the live Referrer table or from the
  // patient's editable `referralSource`, so a rename, a deletion or a corrected
  // referral can never restate what was owed to whom.
  const costGroups = new Map<string, { id: string; name: string; fee: number }[]>();
  for (const c of referralCommissions) {
    if (!inRange(clinicDay(c.incurredAt))) continue;
    const name = c.referrerNameSnapshot.trim() || NOT_SPECIFIED;
    const roster = costGroups.get(name) ?? [];
    roster.push({
      id: c.client.id,
      name: `${c.client.firstName} ${c.client.lastName}`,
      fee: c.amount,
    });
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
    profitSeries,
    packageRevenue,
    externalLab: externalLabProfit,
    topMachines,
    appointmentBreakdown,
    unpaidClients,
    referrerReport,
    referrerCostReport,
    machineUtilization: machineUsage,
    topBloodTests: topBloodTestsOrdered,
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
      // Profitability is the owner's business (docs/01-product-spec.md §2.1).
      revenue: 0,
      grossRevenue: 0,
      discounts: 0,
      cogs: 0,
      grossProfit: 0,
      grossMarginPercent: null,
      revenueByKind: [],
      operatingExpenses: 0,
      referrerCost: 0,
      netProfit: 0,
      totalIncome: 0,
      unpaidBalance: 0,
      // Cash on hand is the owner's P&L question in cash form — admin-only, like
      // every term it is built from.
      referrerPayouts: 0,
      jessyIncome: 0,
      jessyReceived: 0,
      cashCollected: 0,
      cashOut: 0,
      netCash: 0,
      // Receivable/payable ledger figures — reports territory, so admin-only like
      // the totals above.
      jessyOutstanding: 0,
      referralOutstanding: 0,
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
    // The external-lab margin report is a cost/profit figure, so it follows every
    // other one here: admin-only. Note this is a STRICTER gate than the order
    // itself, which a dietitian may see the cost of on the visit they raised —
    // negotiating one lab quote is not the same right as reading the clinic's
    // margin across every patient.
    externalLab: {
      orders: 0,
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      grossMarginPercent: null,
      rows: [],
    },
    // topMachines is NOT redacted: it carries session counts, no money, and is a
    // slice of machineUtilization, which passes through for every role. Zeroing
    // one and not the other would make the chart contradict the table.
    profitSeries: [],
    appointmentBreakdown: [],
    staffActivity: [],
    referrerReport: [],
    referrerCostReport: [],
    unpaidClients: [],
  };
}
