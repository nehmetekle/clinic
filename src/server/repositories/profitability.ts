import { db } from "../db";
import { clinicDay, clinicDayRange, toUsdFrozen } from "@/lib/config";
import { getUsdToLbp } from "./settings";

/**
 * Earned revenue and cost of goods sold — the profitability side of the books.
 *
 * THE RECOGNITION RULE, in one line:
 *
 *   Revenue and its COGS are recognized when the TRANSACTION IS FINALIZED —
 *   when the basket carrying the sale is settled — never when the cash arrives
 *   and never when the thing sold is later delivered.
 *
 * Three consequences worth stating, because each one is a rule someone will
 * otherwise re-litigate:
 *
 *  1. A PREPAID PACKAGE OR SESSION PLAN IS RECOGNIZED IN FULL AT PURCHASE. Ten
 *     sessions sold for $100 with a frozen cost of $10 book $100 revenue, $10
 *     COGS and $90 gross profit on the day they are sold. Using one of those
 *     sessions later recognizes NOTHING — it is fulfilment of something already
 *     sold, and the patient's remaining balance is the only thing that moves.
 *     This is why `covered` lines are excluded below: a covered line is
 *     consumption of prepaid credit, and counting it would recognize the same
 *     sale a second time.
 *
 *  2. A SALE ON CREDIT IS STILL A SALE. A basket settled by deferring its balance
 *     to a ClientDebt is finalized — `paidAt` is set — so it is recognized here in
 *     full. Collecting that debt later is a CASH event and appears only in the
 *     collection figures; it never creates revenue a second time.
 *
 *  3. CASH IS A SEPARATE QUESTION ENTIRELY. Nothing in this file reads a Payment.
 *     What was collected, in what currency, by what method, is the collection
 *     report's business. Mixing the two is how a clinic ends up unable to say
 *     whether a good month was a profitable one.
 *
 * Every figure is built from values FROZEN on the basket line at the moment of
 * sale — `unitPrice`, `unitCost` and the allocated `discountAmount` — so no later
 * edit to the catalog, a package, or the FX rate can restate a closed period.
 */

export type ProfitabilityLine = {
  /** What was sold: consultation_fee | blood_test | treatment | product | package | custom. */
  kind: string;
  revenue: number;
  cogs: number;
};

export type Profitability = {
  /** Net of every discount — the amount actually charged to clients. */
  revenue: number;
  /** Frozen cost of what was sold. */
  cogs: number;
  grossProfit: number;
  /** Gross profit as a percentage of revenue. Null when there is no revenue —
   * a margin on nothing is not 0%, it is undefined, and reporting it as 0 would
   * read as "we sold at cost". */
  grossMarginPercent: number | null;
  /** Gross value before discounts, and the discount given — kept separate so the
   * original prices stay visible next to what was actually charged. */
  grossRevenue: number;
  discounts: number;
  byKind: ProfitabilityLine[];
};

type RawLine = {
  kind: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  discountAmount: number;
  currency: string;
  basket: { usdToLbp: number; paidAt: Date | null };
};

/**
 * The ONE place basket lines become money. Both the headline figures and the
 * monthly trend go through this, so a month read off the chart and the same month
 * selected as the period are the same arithmetic on the same rows — not two
 * implementations that happen to agree today.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

function sumLines(rows: RawLine[], liveRate: number): Profitability {
  const byKind = new Map<string, ProfitabilityLine>();
  let grossRevenue = 0;
  let discounts = 0;
  let revenue = 0;
  let cogs = 0;

  for (const r of rows) {
    // Each line is valued at the rate frozen on its own basket, so a rate change
    // today cannot re-price a sale from last month.
    const usd = (amount: number) =>
      toUsdFrozen(amount, r.currency, r.basket.usdToLbp, liveRate);

    const lineGross = usd(r.unitPrice * r.quantity);
    // The line's frozen share of the bill discount, allocated at settlement with a
    // largest-remainder rule, so the shares across a basket sum exactly to the
    // discount given — revenue therefore reconciles to the amount actually
    // charged, with no residual cent.
    const lineDiscount = usd(r.discountAmount);
    const lineRevenue = lineGross - lineDiscount;
    const lineCogs = usd(r.unitCost * r.quantity);

    grossRevenue += lineGross;
    discounts += lineDiscount;
    revenue += lineRevenue;
    cogs += lineCogs;

    const entry = byKind.get(r.kind) ?? { kind: r.kind, revenue: 0, cogs: 0 };
    entry.revenue += lineRevenue;
    entry.cogs += lineCogs;
    byKind.set(r.kind, entry);
  }

  revenue = round2(revenue);
  cogs = round2(cogs);
  const grossProfit = round2(revenue - cogs);

  return {
    revenue,
    cogs,
    grossProfit,
    // Undefined rather than 0 when nothing was sold — see the type.
    grossMarginPercent: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null,
    grossRevenue: round2(grossRevenue),
    discounts: round2(discounts),
    byKind: [...byKind.values()]
      .map((e) => ({ ...e, revenue: round2(e.revenue), cogs: round2(e.cogs) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

const LINE_SELECT = {
  kind: true,
  quantity: true,
  unitPrice: true,
  unitCost: true,
  discountAmount: true,
  currency: true,
  // The rate frozen on the basket at creation — never today's — and the instant
  // the sale was finalized, which is what every window here is measured against.
  basket: { select: { usdToLbp: true, paidAt: true } },
} as const;

/** Only lines that represent a SALE. A covered line is prepaid credit being
 * consumed; its money was recognized when that package or plan was bought. */
const SOLD_LINE = { covered: false } as const;

/**
 * The window, and optionally ONE dietitian.
 *
 * `dietitianId` scopes to the baskets that dietitian's visits raised. It is only
 * ever applied to the EARNED figures — revenue, COGS and gross profit — because
 * those are the only ones a single dietitian can be said to have produced.
 * Operating expenses (rent, salaries) and referrer commissions belong to the
 * clinic, not to a person; dividing them across dietitians would invent an
 * allocation nobody has agreed, so no caller here does it, and there is
 * deliberately no per-dietitian net profit.
 */
export type ProfitabilityRange = { from?: string; to?: string; dietitianId?: string };

function basketWhere(range: ProfitabilityRange) {
  const gte = range.from ? clinicDayRange(range.from).gte : undefined;
  const lt = range.to ? clinicDayRange(range.to).lt : undefined;
  return {
    // BOTH settled statuses, never `paid` alone. `closed` is not a different kind
    // of sale — it is the SAME settled basket after `retirePaidBasketsTx` retired
    // it from the settlement queue when the dietitian closed the visit. Filtering
    // on `paid` only made revenue evaporate retroactively: a sale counted while
    // its visit was open silently left the books the moment the visit closed, so
    // Revenue drifted below Collected by exactly the closed visits' takings.
    // `paidAt` (set once, at settlement) is what dates the sale — the status only
    // says whether the basket is still on the board.
    status: { in: ["paid", "closed"] },
    ...(range.dietitianId ? { dietitianId: range.dietitianId } : {}),
    ...(gte || lt ? { paidAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } } : {}),
  };
}

/**
 * Sums the settled basket lines whose basket was finalized within the window.
 *
 * The window is resolved through `clinicDayRange`, so the boundary is clinic
 * midnight in the clinic's own timezone — the same boundary every other money
 * figure uses. Building it from raw UTC strings (`"...T00:00:00.000Z"`) would
 * shift the period by the UTC offset and put a late-evening sale in the wrong
 * month; that bug exists elsewhere in this codebase and is deliberately not
 * repeated here.
 */
export async function getProfitability(range: ProfitabilityRange): Promise<Profitability> {
  const [rows, liveRate] = await Promise.all([
    db.visitBasketItem.findMany({
      where: { ...SOLD_LINE, basket: basketWhere(range) },
      select: LINE_SELECT,
    }),
    getUsdToLbp(),
  ]);
  return sumLines(rows, liveRate);
}

/**
 * Revenue and COGS bucketed by CLINIC month, for the trend chart.
 *
 * One query for the whole span, then bucketed with `clinicDay` — the same
 * function that decides which day every other figure belongs to — so a sale near
 * midnight at a month boundary lands in the same month here as it does in the
 * headline cards. The per-bucket arithmetic is `sumLines`, shared with
 * `getProfitability`, so the chart cannot drift from the cards by construction.
 *
 * Returns a map keyed "YYYY-MM"; months with no sales are simply absent and the
 * caller supplies zeros.
 */
export async function getMonthlyProfitability(
  fromDay: string,
  toDay: string,
  dietitianId?: string,
): Promise<Map<string, Profitability>> {
  const [rows, liveRate] = await Promise.all([
    db.visitBasketItem.findMany({
      where: {
        ...SOLD_LINE,
        basket: basketWhere({ from: fromDay, to: toDay, dietitianId }),
      },
      select: LINE_SELECT,
    }),
    getUsdToLbp(),
  ]);

  const buckets = new Map<string, RawLine[]>();
  for (const r of rows) {
    if (!r.basket.paidAt) continue;
    const key = clinicDay(r.basket.paidAt).slice(0, 7);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  const out = new Map<string, Profitability>();
  for (const [key, list] of buckets) out.set(key, sumLines(list, liveRate));
  return out;
}

export type BundleProfitability = {
  /** The FROZEN name the bundle was sold under. */
  name: string;
  /** Number of bundle sales in the period. */
  sales: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number | null;
};

/**
 * Profitability per bundle, built from the FINALIZED SALES themselves.
 *
 * A `package` basket line is one whole prepaid bundle sold: quantity 1, with the
 * bundle's entire frozen price and cost on the line and its allocated share of any
 * bill discount. So revenue here is what was actually charged after discount, COGS
 * is the cost frozen at the sale, and neither moves afterwards. A $90 bundle
 * costing $10 contributes $90 / $10 / $80 whether the patient has used 0 of 10
 * sessions or all 10 — usage is fulfilment of a sale already recognized and is
 * deliberately not consulted here.
 *
 * Grouped by the frozen `ClientPackage.packageName`, never by the payment motif,
 * the individual payment or the patient. Renaming a bundle in the catalog cannot
 * restate a closed period, because the name each sale is filed under is the one
 * captured when it was sold.
 *
 * These rows are the same lines the profitability report counts under `package`,
 * merely grouped differently, so they sum exactly to that row of Revenue and COGS.
 */
export async function getBundleProfitability(
  range: ProfitabilityRange,
): Promise<BundleProfitability[]> {
  const [rows, liveRate] = await Promise.all([
    db.visitBasketItem.findMany({
      where: { ...SOLD_LINE, kind: "package", basket: basketWhere(range) },
      select: {
        ...LINE_SELECT,
        label: true,
        clientPackage: { select: { packageName: true } },
      },
    }),
    getUsdToLbp(),
  ]);

  const byName = new Map<string, { sales: number; rows: RawLine[] }>();
  for (const r of rows) {
    // The frozen name on the sold package; the line's own frozen label is the
    // fallback for a line whose ClientPackage row is gone.
    const name = r.clientPackage?.packageName ?? r.label;
    const entry = byName.get(name) ?? { sales: 0, rows: [] };
    entry.sales += 1;
    entry.rows.push(r);
    byName.set(name, entry);
  }

  return [...byName.entries()]
    .map(([name, e]) => {
      // Same arithmetic as every other money figure in this file — one bundle's
      // lines put through the shared summer rather than re-derived.
      const p = sumLines(e.rows, liveRate);
      return {
        name,
        sales: e.sales,
        revenue: p.revenue,
        cogs: p.cogs,
        grossProfit: p.grossProfit,
        grossMarginPercent: p.grossMarginPercent,
      };
    })
    .sort((a, b) => b.grossProfit - a.grossProfit || b.revenue - a.revenue);
}

export type ExternalLabOrderProfitability = {
  orderId: string;
  /** Clinic day the sale was FINALIZED (the basket settled) — not the day the
   * order was raised, so it agrees with every other earned figure. */
  date: string;
  clientId: string;
  clientName: string;
  visitNumber: number;
  /** The tests the order covered, in the order they were listed. */
  tests: string[];
  /** What the patient was charged, net of the line's share of any bill discount. */
  revenue: number;
  /** What the external lab charged the clinic, frozen at the sale. */
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number | null;
};

export type ExternalLabProfitability = {
  /** Number of settled external-lab orders in the window. */
  orders: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPercent: number | null;
  /** Newest settlement first. */
  rows: ExternalLabOrderProfitability[];
};

/**
 * External-lab blood collection, per order and in total.
 *
 * These are the SAME settled basket lines the headline Revenue/COGS cards
 * already count under the `external_lab` kind — grouped and labelled, never
 * re-derived — so this section sums exactly to that row of the revenue
 * breakdown and cannot drift from it.
 *
 * The margin is the whole point of the section: the lab quotes a different lump
 * sum for the same two tests from one week to the next, so the only way to know
 * whether the clinic is making money on outsourced labs is order by order.
 *
 * Recognition follows the file's rule without exception: an order is counted
 * when its basket is SETTLED, priced at the figures frozen on the line at that
 * moment. A pending order is not revenue and appears nowhere here, however
 * confidently it has been priced; an order settled by deferring its balance to a
 * ClientDebt is a finalized sale and is counted in full.
 *
 * ADMIN-ONLY, like every other cost figure that reaches a report. The dietitian
 * may see the cost of an order they are working on (they negotiated it); the
 * clinic-wide margin is a financial report, which docs/01-product-spec.md §2.1
 * reserves for the admin.
 */
export async function getExternalLabProfitability(
  range: ProfitabilityRange,
): Promise<ExternalLabProfitability> {
  const [rows, liveRate] = await Promise.all([
    db.visitBasketItem.findMany({
      where: { ...SOLD_LINE, kind: "external_lab", basket: basketWhere(range) },
      select: {
        ...LINE_SELECT,
        externalLabOrder: {
          select: {
            id: true,
            tests: { orderBy: { position: "asc" }, select: { name: true } },
            consultation: {
              select: {
                visitNumber: true,
                client: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
        },
        basket: {
          select: {
            usdToLbp: true,
            paidAt: true,
            client: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    getUsdToLbp(),
  ]);

  const perOrder: ExternalLabOrderProfitability[] = rows.map((r) => {
    const usd = (amount: number) => toUsdFrozen(amount, r.currency, r.basket.usdToLbp, liveRate);
    const revenue = round2(usd(r.unitPrice * r.quantity) - usd(r.discountAmount));
    const cogs = round2(usd(r.unitCost * r.quantity));
    const grossProfit = round2(revenue - cogs);
    // The basket's client is the fallback for a line whose order row is gone —
    // it can't be today (the FK is ON DELETE SET NULL and only a cascade from a
    // deleted visit removes an order), but a report must still render a row it
    // has revenue for rather than dropping money from a total.
    const client = r.externalLabOrder?.consultation.client ?? r.basket.client;
    return {
      orderId: r.externalLabOrder?.id ?? "",
      date: r.basket.paidAt ? clinicDay(r.basket.paidAt) : "",
      clientId: client.id,
      clientName: `${client.firstName} ${client.lastName}`,
      visitNumber: r.externalLabOrder?.consultation.visitNumber ?? 0,
      tests: r.externalLabOrder?.tests.map((t) => t.name) ?? [],
      revenue,
      cogs,
      grossProfit,
      grossMarginPercent: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null,
    };
  });

  // Totals are summed from the SAME per-order figures the table shows, so the
  // card and the rows beneath it can never disagree by a rounding cent.
  const revenue = round2(perOrder.reduce((n, o) => n + o.revenue, 0));
  const cogs = round2(perOrder.reduce((n, o) => n + o.cogs, 0));
  const grossProfit = round2(revenue - cogs);

  return {
    orders: perOrder.length,
    revenue,
    cogs,
    grossProfit,
    // Undefined rather than 0 on no revenue — same rule as everywhere else here.
    grossMarginPercent: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null,
    rows: perOrder.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  };
}
