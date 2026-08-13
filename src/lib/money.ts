/**
 * Tender currencies and FX — the single source of truth for turning money the
 * patient physically hands over into the USD the clinic accounts in.
 *
 * The product invariant this file exists to protect:
 *
 *   Obligations (visit baskets, client debts, session plans, catalog prices,
 *   the Jessy receivable ledger) are denominated in USD.
 *   PAYMENTS may be TENDERED in USD, EUR or LBP.
 *
 * So `Currency` (in types.ts) stays the *denomination* of an obligation and is
 * deliberately NOT widened to EUR; `TenderCurrency` here is the currency of the
 * cash/card actually handed over. Widening the wrong one would turn this into a
 * foreign-currency accounting system, which is explicitly out of scope.
 *
 * Rate direction is fixed and stated once, here, so it can never be inverted by
 * accident at a call site:
 *
 *   fxRate = units of the tender currency per 1 USD
 *   USD equivalent = native amount / fxRate
 *
 * (USD => 1, EUR => ~0.92, LBP => ~89,500.)
 */

export const TENDER_CURRENCY_VALUES = ["USD", "EUR", "LBP"] as const;
export type TenderCurrency = (typeof TENDER_CURRENCY_VALUES)[number];

export const TENDER_CURRENCY_LABELS: Record<TenderCurrency, string> = {
  USD: "USD ($)",
  EUR: "EUR (€)",
  LBP: "LBP (ل.ل)",
};

/** Symbol used when rendering a native tender amount inline. */
export const TENDER_CURRENCY_SYMBOLS: Record<TenderCurrency, string> = {
  USD: "$",
  EUR: "€",
  LBP: "LBP ",
};

/** Practical decimal places of each tender currency (LBP has no subunit in use). */
export const TENDER_DECIMALS: Record<TenderCurrency, number> = { USD: 2, EUR: 2, LBP: 0 };

export function isTenderCurrency(v: unknown): v is TenderCurrency {
  return typeof v === "string" && (TENDER_CURRENCY_VALUES as readonly string[]).includes(v);
}

/**
 * Thrown when money cannot be converted safely. Never caught-and-defaulted: a
 * settlement that cannot be valued must fail, not guess. `handleError` maps this
 * to a 409 with the message, so the desk sees what is wrong instead of a 500.
 */
export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

/** The admin-controlled rates, as stored in Settings. */
export type FxRates = { usdToLbp: number; usdToEur: number };

/**
 * Sanity bounds per currency. These are NOT market bounds — they are "this is a
 * misconfiguration, not a devaluation" bounds, wide enough that a real rate move
 * can never trip them. They exist so a corrupted/absurd Setting (or an Infinity
 * that slipped through validation) can never value a payment at $0 or $10^9.
 */
const FX_BOUNDS: Record<TenderCurrency, { min: number; max: number }> = {
  USD: { min: 1, max: 1 },
  EUR: { min: 0.01, max: 100 },
  LBP: { min: 1, max: 100_000_000 },
};

/**
 * Rejects any rate that cannot produce a trustworthy USD value: non-finite
 * (Infinity/NaN), non-positive, or outside the currency's sanity bounds.
 * Deliberately throws rather than falling back — a silent fallback here is how a
 * settlement gets valued at the wrong rate without anyone noticing.
 */
export function assertUsableFxRate(currency: TenderCurrency, rate: number): void {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new FxError(
      `The ${currency} exchange rate is not usable (${String(rate)}). Set a valid rate in Settings before recording this payment.`,
    );
  }
  const { min, max } = FX_BOUNDS[currency];
  if (rate < min || rate > max) {
    throw new FxError(
      `The ${currency} exchange rate (${rate}) is outside the accepted range ${min}–${max}. Correct it in Settings before recording this payment.`,
    );
  }
}

/**
 * The rate to freeze onto a payment tendered in `currency`, resolved from the
 * admin-controlled settings. Exhaustive over TenderCurrency: a currency added to
 * the union without a rate here is a compile error, not a silent 1:1.
 */
export function fxRateFor(currency: TenderCurrency, rates: FxRates): number {
  let rate: number;
  switch (currency) {
    case "USD":
      rate = 1;
      break;
    case "EUR":
      rate = rates.usdToEur;
      break;
    case "LBP":
      rate = rates.usdToLbp;
      break;
    default: {
      // Unreachable while the switch is exhaustive; kept so an unvalidated string
      // reaching here fails closed instead of being treated as USD.
      const never: never = currency;
      throw new FxError(`Unsupported tender currency: ${String(never)}`);
    }
  }
  assertUsableFxRate(currency, rate);
  return rate;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The canonical USD value of one tender leg. This is the ONE place a native
 * amount becomes money the clinic accounts in — frontend preview and backend
 * settlement both call it, so the figure the secretary sees and the figure that
 * is enforced cannot drift.
 *
 * Rounded to the cent exactly once, here. Callers must not re-round the result.
 */
export function tenderToUsd(native: number, currency: TenderCurrency, fxRate: number): number {
  if (!Number.isFinite(native)) {
    throw new FxError(`Amount is not a finite number (${String(native)}).`);
  }
  if (currency === "USD") return round2(native);
  assertUsableFxRate(currency, fxRate);
  const usd = native / fxRate;
  if (!Number.isFinite(usd)) {
    throw new FxError(`Converting ${native} ${currency} at ${fxRate} produced a non-finite value.`);
  }
  return round2(usd);
}

/**
 * The native amount that is worth `usd` — the inverse of `tenderToUsd`, used by
 * the settlement modal's auto-balancing row so the secretary is told what to
 * physically collect. Rounded to the currency's practical precision (LBP to the
 * whole lira), which is why the round-trip back through `tenderToUsd` may differ
 * from `usd` by a fraction of a cent — that residual is what
 * `settlementToleranceUsd` accounts for.
 */
export function usdToTender(usd: number, currency: TenderCurrency, fxRate: number): number {
  if (!Number.isFinite(usd)) return 0;
  if (currency === "USD") return round2(usd);
  assertUsableFxRate(currency, fxRate);
  const factor = 10 ** TENDER_DECIMALS[currency];
  return Math.round(usd * fxRate * factor) / factor;
}

/**
 * How far the sum of a settlement's legs may sit from the amount due.
 *
 * HALF A CENT, always — it does not scale with the number of foreign legs.
 *
 * The reasoning matters, because an earlier version of this function did scale
 * it (half a cent per converted leg) on the theory that each conversion
 * introduces rounding error to absorb. That theory is wrong, and the mistake let
 * a full cent of underpayment through on a single-EUR-leg settlement:
 *
 *   Every leg's USD value is `round2(native / rate)`, so it lands exactly on a
 *   cent boundary. The amount due is `round2(...)` too. Both sides of the
 *   comparison are therefore whole numbers of cents, and their difference is
 *   always an exact multiple of $0.01 — never a fraction of one. There is no
 *   sub-cent residue to absorb, because the recorded value IS the rounded value.
 *
 * So the only difference this epsilon may forgive is IEEE-754 representation
 * noise (99.99 − 100 evaluates to −0.010000000000005, not −0.01). Half a cent
 * covers that with enormous margin while remaining far below the smallest real
 * discrepancy, which guarantees by construction that a full cent short or over
 * ALWAYS fails — for USD-only and mixed settlements alike.
 *
 * The parameter is kept so call sites read as "the tolerance for these legs" and
 * so a future tender currency with sub-cent granularity has an obvious place to
 * change the rule deliberately rather than by accident.
 */
export const SETTLEMENT_EPSILON_USD = 0.005;

export function settlementToleranceUsd(
  _legs: readonly { currency: TenderCurrency }[],
): number {
  return SETTLEMENT_EPSILON_USD;
}

/**
 * The FROZEN rate of an already-recorded payment.
 *
 * Historical value must be reconstructible FROM THE ROW ALONE — never from
 * today's Settings, never from a static default. There is deliberately NO
 * fallback: a row that cannot be valued from its own stored data throws, because
 * every alternative silently invents a number and calls it history.
 *
 * Two stored fields can carry the rate:
 *  - `fxRate` — written on every payment since multi-currency tender.
 *  - `usdToLbp` — the pre-`fxRate` snapshot. For an LBP row it means EXACTLY the
 *    same thing (units per USD), which is what makes reading legacy rows
 *    behaviour-preserving rather than a re-valuation.
 *
 * The no-fallback position is evidence-based, not optimistic: every revision of
 * `createPayment` in this repository's history writes
 * `usdToLbp: await getUsdToLbp()`, and `getUsdToLbp()` is guarded to return a
 * positive rate, so no payment the application has ever written can lack one. The
 * `Payment_valuable` CHECK constraint (multi_currency_tender_audit migration)
 * makes it structurally impossible going forward — including for rows inserted by
 * hand or by a future migration.
 *
 * If this ever throws, the row is corrupt and needs manual remediation; the
 * message carries the identifiers needed to find it. Failing a page is the
 * correct outcome — a total that is quietly wrong is far worse than one that
 * refuses to render.
 */
export function frozenPaymentFxRate(row: {
  currency: string;
  usdToLbp: number;
  fxRate?: number | null;
  receiptNumber?: string;
}): { currency: TenderCurrency; fxRate: number } {
  const ref = row.receiptNumber ? ` (receipt ${row.receiptNumber})` : "";
  if (!isTenderCurrency(row.currency)) {
    throw new FxError(
      `Payment${ref} has an unsupported currency (${String(row.currency)}) and cannot be valued. ` +
        `This row needs manual correction — no rate is assumed for it.`,
    );
  }
  const currency = row.currency;
  // USD is rate-independent, so a missing/zero snapshot on a USD row is harmless.
  if (currency === "USD") return { currency, fxRate: 1 };

  if (row.fxRate != null && Number.isFinite(row.fxRate) && row.fxRate > 0) {
    return { currency, fxRate: row.fxRate };
  }
  // Pre-`fxRate` LBP row: its own snapshot, not a guess.
  if (currency === "LBP" && Number.isFinite(row.usdToLbp) && row.usdToLbp > 0) {
    return { currency, fxRate: row.usdToLbp };
  }
  throw new FxError(
    `Payment${ref} was taken in ${currency} but carries no valid frozen exchange rate, ` +
      `so its USD value cannot be reconstructed. It is reported rather than valued at a ` +
      `guessed rate — correct the row's stored rate to resolve this.`,
  );
}

/**
 * USD value of a recorded payment-shaped row, at ITS OWN frozen rate. Every
 * report, dashboard figure and drill-down that sums payments goes through this,
 * so changing today's rate can never re-price yesterday's money.
 */
export function paymentUsd(row: {
  amountPaid: number;
  currency: string;
  usdToLbp: number;
  fxRate?: number | null;
  receiptNumber?: string;
}): number {
  const { currency, fxRate } = frozenPaymentFxRate(row);
  return tenderToUsd(row.amountPaid, currency, fxRate);
}

/**
 * Renders a native tender amount with its own precision — unlike `formatMoney`,
 * which drops decimals app-wide. Used wherever a foreign-currency leg is shown
 * next to its USD equivalent, because "€217" beside "≈ $217.39" is unauditable.
 */
export function formatTender(amount: number, currency: TenderCurrency): string {
  const decimals = TENDER_DECIMALS[currency];
  return `${TENDER_CURRENCY_SYMBOLS[currency]}${amount.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * USD to the CENT. `formatMoney` renders whole dollars app-wide, which is fine
 * for a headline figure but unauditable next to a converted foreign amount —
 * "€200 ≈ $217" hides the 39c the clinic actually banked.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "1 USD = €0.92" / "1 USD = 89,500 LBP" — the rate a leg was valued at. */
export function formatFxRate(currency: TenderCurrency, fxRate: number): string {
  if (currency === "USD") return "1 USD = $1.00";
  const decimals = currency === "LBP" ? 0 : 4;
  return `1 USD = ${TENDER_CURRENCY_SYMBOLS[currency]}${fxRate.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
  })}`;
}


// ---------------------------------------------------------------------------
// Suspicious-rate detection
// ---------------------------------------------------------------------------

/**
 * The two Setting keys that hold a convertible rate, and the currency each one
 * prices. Keeping this next to `FX_BOUNDS` is what stops the audit history, the
 * suspicious guard and the converter from disagreeing about what a key means.
 */
export const FX_RATE_KEYS = ["usdToLbp", "usdToEur"] as const;
export type FxRateKey = (typeof FX_RATE_KEYS)[number];

export const FX_RATE_CURRENCY: Record<FxRateKey, TenderCurrency> = {
  usdToLbp: "LBP",
  usdToEur: "EUR",
};

export const FX_RATE_LABELS: Record<FxRateKey, string> = {
  usdToLbp: "USD → LBP",
  usdToEur: "USD → EUR",
};

export function isFxRateKey(v: unknown): v is FxRateKey {
  return typeof v === "string" && (FX_RATE_KEYS as readonly string[]).includes(v);
}

/**
 * How far a rate may move in one edit before the admin has to confirm.
 *
 * `FX_BOUNDS` already rejects the impossible; this is the second layer, aimed at
 * the mistake those bounds cannot see — a plausible-looking number that is wrong
 * by an order of magnitude (0.92 -> 92, 89,500 -> 895). Both of those sit
 * comfortably inside the absolute bounds, so only a RELATIVE check catches them.
 *
 * The two currencies genuinely need different sensitivities, so this is not one
 * blanket percentage:
 *
 *  - **EUR** is a floating major-pair rate. Real daily moves are fractions of a
 *    percent; 2% in a single edit is already a large correction. 25% allows for a
 *    rate left stale for months and then caught up, while still catching a
 *    factor-of-100 slip by a wide margin.
 *  - **LBP** has a recent history of step re-pegs (1,507 -> 15,000 -> 89,500), so
 *    a legitimate change can be several hundred percent. The threshold is set to
 *    catch an order-of-magnitude typo rather than a re-peg: a 10x slip trips it,
 *    a doubling does not.
 *
 * Expressed as a maximum ratio in either direction, which is the shape that
 * treats "x10" and "÷10" as equally suspicious — a percentage does not.
 */
const FX_SUSPICIOUS_RATIO: Record<FxRateKey, number> = {
  usdToEur: 1.25,
  usdToLbp: 4,
};

export type FxSuspicion = {
  rateKey: FxRateKey;
  oldValue: number;
  newValue: number;
  /** How many times bigger/smaller the new rate is (always >= 1). */
  factor: number;
  /** The ratio at which this rate starts requiring confirmation. */
  threshold: number;
};

/**
 * Returns a description of why a change looks like a data-entry mistake, or null
 * when it is unremarkable. A first-ever set (no previous value) is never
 * suspicious — there is nothing to compare it against, and `FX_BOUNDS` already
 * covers absolute nonsense.
 */
export function detectSuspiciousRateChange(
  rateKey: FxRateKey,
  oldValue: number | null | undefined,
  newValue: number,
): FxSuspicion | null {
  if (oldValue == null || !Number.isFinite(oldValue) || oldValue <= 0) return null;
  if (!Number.isFinite(newValue) || newValue <= 0) return null;
  const factor = newValue > oldValue ? newValue / oldValue : oldValue / newValue;
  const threshold = FX_SUSPICIOUS_RATIO[rateKey];
  if (factor <= threshold) return null;
  return { rateKey, oldValue, newValue, factor, threshold };
}

/** Desk-readable explanation of a suspicious change, used by the API and the UI. */
export function describeSuspicion(s: FxSuspicion): string {
  const currency = FX_RATE_CURRENCY[s.rateKey];
  return (
    `That would change the ${FX_RATE_LABELS[s.rateKey]} rate from ` +
    `${formatFxRate(currency, s.oldValue)} to ${formatFxRate(currency, s.newValue)} — ` +
    `a ${s.factor.toFixed(1)}× move. Every payment taken in ${currency} from now on ` +
    `would be valued at the new rate. Confirm only if this is deliberate.`
  );
}


// ---------------------------------------------------------------------------
// Stale-rate detection (settlement)
// ---------------------------------------------------------------------------

/**
 * Thrown when the settlement screen was prepared against one set of rates and the
 * admin changed them before it was submitted.
 *
 * The server is always authoritative — it never values a leg with a rate the
 * browser sent. But re-pricing silently would mean the desk collects €368
 * believing it is $400 while the system books $409, and the patient walks away
 * short. So a settlement prepared at a rate that has since moved is REJECTED
 * outright and nothing is written, with a message that names the real cause
 * instead of blaming the arithmetic.
 *
 * Carries the authoritative rates so the screen can re-price itself immediately.
 */
export class StaleFxRateError extends Error {
  rates: FxRates;
  detail: {
    currency: TenderCurrency;
    displayedRate: number;
    currentRate: number;
  }[];
  constructor(
    message: string,
    rates: FxRates,
    detail: StaleFxRateError["detail"],
  ) {
    super(message);
    this.name = "StaleFxRateError";
    this.rates = rates;
    this.detail = detail;
  }
}

/**
 * Compares the rates the settlement screen displayed against the authoritative
 * ones, for the currencies actually used in this settlement.
 *
 * Only the currencies being tendered matter: an LBP rate change is irrelevant to
 * a USD+EUR settlement and must not block it. A settlement with no foreign leg is
 * never stale — there is no rate involved.
 *
 * `expected` is advisory input from the client and is used ONLY to decide whether
 * to reject. It can never be used to VALUE anything, so a forged value cannot
 * change a single figure: the worst a crafted `expected` achieves is refusing its
 * own settlement (or skipping a warning it would have received, after which the
 * ordinary reconcile check still rejects the mismatched total).
 */
export function detectStaleRates(
  legs: readonly { currency: TenderCurrency }[],
  expected: Partial<Record<TenderCurrency, number>> | undefined,
  authoritative: FxRates,
): StaleFxRateError["detail"] {
  if (!expected) return [];
  const used = new Set(legs.map((l) => l.currency));
  const detail: StaleFxRateError["detail"] = [];
  for (const currency of used) {
    if (currency === "USD") continue;
    const displayed = expected[currency];
    if (displayed == null || !Number.isFinite(displayed) || displayed <= 0) continue;
    const current = fxRateFor(currency, authoritative);
    // Exact comparison is right here: rates are stored as typed decimals, not
    // computed, so any difference at all is a real edit rather than float drift.
    if (displayed !== current) {
      detail.push({ currency, displayedRate: displayed, currentRate: current });
    }
  }
  return detail;
}

/** The desk-readable explanation shown when a settlement is rejected as stale. */
export function describeStaleRates(detail: StaleFxRateError["detail"]): string {
  const changes = detail
    .map(
      (d) =>
        `${d.currency}: was ${formatFxRate(d.currency, d.displayedRate)}, now ${formatFxRate(d.currency, d.currentRate)}`,
    )
    .join("; ");
  return (
    "The exchange rate changed since this payment was prepared " +
    `(${changes}). Nothing has been charged. Please review the updated amounts and submit again.`
  );
}
