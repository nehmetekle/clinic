import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { CLINIC, clinicMinutesOfDay, isWeekendIso, toUsd } from "./config";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The app-wide money formatter.
 *
 * Shows cents ONLY when the amount actually has them. It used to hard-round to
 * whole units (`maximumFractionDigits: 0`), which was fine while every figure in
 * the app was a round catalog price — but is actively misleading now that
 * foreign tender produces real fractional amounts: a $182.61 remaining debt
 * rendered as "$183", so the desk would try to collect $183 and be refused as
 * over-payment, and a $217.39 Jessy balance rendered as "$217" could never be
 * reconciled to zero.
 *
 * `minimumFractionDigits: 0` is what keeps this from being a cosmetic rewrite of
 * every screen: $12,450 still reads "$12,450", not "$12,450.00". Only amounts
 * that genuinely carry cents gain them. LBP is unaffected — those amounts are
 * whole numbers by nature.
 *
 * Use `formatUsd` (lib/money.ts) instead where a trailing ".00" is *wanted* as a
 * signal of exactness — receipts, settlement reconciliation, FX equivalents.
 */
export function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(amount: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(amount);
}

export function stripNumberFormatting(value: string) {
  return value.replace(/,/g, "").trim();
}

export function sanitizeNumberInput(value: string) {
  const clean = stripNumberFormatting(value).replace(/[^\d.]/g, "");
  const [integer = "", ...decimalParts] = clean.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "");
  const decimal = decimalParts.join("");
  return decimalParts.length > 0 ? `${normalizedInteger || "0"}.${decimal}` : normalizedInteger;
}

export function formatNumberInput(value: string) {
  const clean = sanitizeNumberInput(value);
  if (!clean) return "";

  const [integer, decimal] = clean.split(".");
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimal === undefined ? formattedInteger : `${formattedInteger}.${decimal}`;
}

export function parseNumberInput(value: string) {
  return Number(sanitizeNumberInput(value) || 0);
}

// ---- R5: money-input sanity bounds (shared by client forms and server zod) ----
// Reject negatives and unreasonably large amounts instead of silently clamping.
// Caps are currency-aware — LBP amounts are legitimately large (~89,500 : 1 USD),
// so a single flat ceiling would wave through absurd USD or reject valid LBP.
export const MAX_USD = 1_000_000;
export const MAX_LBP = 10_000_000_000;
// EUR is close enough to USD in magnitude to share its ceiling.
export const MAX_EUR = 1_000_000;
export function moneyCap(currency: string | undefined): number {
  switch (currency) {
    case "LBP":
      return MAX_LBP;
    case "EUR":
      return MAX_EUR;
    default:
      // USD and "unspecified" (which every schema treats as USD). An unknown
      // currency gets the TIGHTEST cap rather than the loosest — the currency
      // itself is rejected elsewhere; this must not be the loophole that lets an
      // absurd amount through while that rejection is being decided.
      return MAX_USD;
  }
}

// Both formatters render in the clinic's timezone (CLINIC.timeZone), so a viewer's
// device timezone never shifts the displayed day/time — everyone sees the clinic's
// clock. A date-only "YYYY-MM-DD" parses as UTC midnight; rendering it in the
// clinic zone keeps it on the intended day.
export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: CLINIC.timeZone,
  });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: CLINIC.timeZone,
  });
}

// Clinic hours: appointments run 9:00–18:00 in 30-minute slots. The last
// bookable start is 17:30 so a 30-minute visit finishes by closing time.
export const CLINIC_OPEN_MIN = 9 * 60; // 09:00
export const CLINIC_LAST_SLOT_MIN = 17 * 60 + 30; // 17:30

const pad2 = (n: number) => String(n).padStart(2, "0");
const minutesToTime = (mins: number) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

/** Formats a 24-hour "HH:MM" time as AM/PM, e.g. "09:30" → "9:30 AM". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad2(m)} ${period}`;
}

/** All bookable 30-minute slots between clinic open and the last start time. */
export function timeSlots(): string[] {
  const slots: string[] = [];
  for (let m = CLINIC_OPEN_MIN; m <= CLINIC_LAST_SLOT_MIN; m += 30) slots.push(minutesToTime(m));
  return slots;
}

/** Adds `n` days to a `YYYY-MM-DD` string via pure UTC calendar arithmetic — a
 * timezone-independent shift on the date itself (no "now", no local/UTC slip). */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** The given date, or the next weekday if it falls on a weekend — the clinic is
 * closed Sat/Sun, so a booking default must never land on one. */
function nextOpenIso(iso: string): string {
  let d = iso;
  while (isWeekendIso(d)) d = addDaysIso(d, 1);
  return d;
}

/**
 * Default appointment date + time for a new booking:
 * - rounds the current time up to the next 30-minute slot within clinic hours;
 * - before opening → first slot today;
 * - after the last slot → first slot on the next day (`todayIso` + 1).
 * The clinic is closed on weekends, so if that lands on a Sat/Sun the date rolls
 * forward to the next open weekday (at the opening slot) — otherwise the field
 * pre-fills with a weekend date the server rejects.
 * `now` defaults to the real clock so "next available slot" reflects current time.
 */
export function defaultSlot(todayIso: string, now: Date = new Date()): { date: string; time: string } {
  // Clinic-clock minutes-of-day, so "next available slot" tracks the clinic's
  // time even when the person booking is in another timezone.
  const mins = clinicMinutesOfDay(now);
  const rounded = Math.ceil(mins / 30) * 30;

  let date = todayIso;
  let time = minutesToTime(CLINIC_OPEN_MIN);
  if (rounded > CLINIC_LAST_SLOT_MIN) {
    date = addDaysIso(todayIso, 1); // after the last slot → first slot tomorrow
  } else if (rounded >= CLINIC_OPEN_MIN) {
    time = minutesToTime(rounded); // within clinic hours → next slot today
  } // before opening → today, first slot

  if (isWeekendIso(date)) {
    // Rolled onto (or started on) a weekend — advance to the next open day and
    // reset to the opening slot, since we're no longer on "today".
    date = nextOpenIso(date);
    time = minutesToTime(CLINIC_OPEN_MIN);
  }
  return { date, time };
}

export type BasketLine = { quantity: number; unitPrice: number; covered?: boolean; currency?: string };

/**
 * USD value of ONE basket line — the single place a line's currency is folded to
 * USD. Package/credit-covered lines stay in the basket for tracking but never
 * contribute to the charge, so they evaluate to 0. LBP lines fold in at the
 * basket's frozen `usdToLbp`.
 */
export function basketLineUsd(item: BasketLine, usdToLbp: number = CLINIC.defaultUsdToLbp): number {
  if (item.covered) return 0;
  return toUsd(item.unitPrice * item.quantity, item.currency ?? "USD", usdToLbp);
}

/**
 * The ONE discount formula for the whole app: a percent is clamped to 0–100% of
 * the subtotal; a fixed amount is capped at the subtotal. Never negative, never
 * more than the subtotal. Every basket/visit/debt total routes through this so
 * the rule can't drift between call sites.
 */
export function discountAmount(
  subtotal: number,
  type: "percent" | "amount" | null | undefined,
  value: number | null | undefined,
): number {
  const v = Math.max(0, value ?? 0);
  if (type === "percent") return Math.min(subtotal, (subtotal * Math.min(v, 100)) / 100);
  if (type === "amount") return Math.min(subtotal, v);
  return 0;
}

/**
 * The card-payment surcharge fee: `ratePercent`% of `amount`, applied only when
 * `method` is "card" (0 for every other method) and only while a positive rate
 * is configured (Settings "cardSurchargePercent" — 0 disables it entirely).
 * Mirrors `discountAmount`'s shape (a single formula, never negative) so it's
 * computed the same way everywhere it's charged.
 */
export function cardSurchargeAmount(
  amount: number,
  method: string,
  ratePercent: number,
): number {
  if (method !== "card" || !(ratePercent > 0) || !(amount > 0)) return 0;
  return Math.round(amount * (ratePercent / 100) * 100) / 100;
}

/**
 * Shared visit-basket math used by the dietitian's editor, the secretary's
 * settlement card, and the server. Built entirely from `basketLineUsd` +
 * `discountAmount` so there is a single source of truth for currency folding and
 * the discount rule. Totals are computed in USD (the single source of truth): any
 * LBP line folds in at `usdToLbp` (the basket's frozen rate), so a mix of
 * currencies still combines into one correct figure.
 */
/**
 * Splits a whole-bill discount across the lines it applies to, so the discounted
 * line amounts sum EXACTLY to the discounted bill total.
 *
 * A bill discount is agreed on the bill, not on any one item, so it is shared out
 * in proportion to what each line contributes — never dropped onto whichever line
 * happens to be first, which would misstate the revenue of both that line and
 * every other one.
 *
 * Exactness is the whole point, and naive proportional division does not give it:
 * three $10 lines sharing a $10 discount each want $3.333…, which rounds to
 * $3.33 and loses a cent against the total. This uses the LARGEST REMAINDER
 * method — floor every share to the cent, then hand the leftover cents out one
 * at a time to the lines with the largest fractional parts. The result always
 * satisfies `Σ allocated === discount` to the cent, so revenue reconciles to the
 * amount actually charged with no residual anywhere.
 *
 * Covered lines (already paid for out of prepaid credit) contribute nothing to
 * the bill and therefore absorb none of the discount.
 */
export function allocateDiscount(
  lines: { gross: number; covered?: boolean }[],
  discount: number,
): number[] {
  const alloc = lines.map(() => 0);
  const cents = Math.round(Math.max(0, discount) * 100);
  if (cents === 0) return alloc;

  const eligible = lines
    .map((l, index) => ({ index, gross: l.covered ? 0 : Math.max(0, l.gross) }))
    .filter((l) => l.gross > 0);
  const total = eligible.reduce((s, l) => s + l.gross, 0);
  // Nothing to discount against: refuse to invent an allocation rather than
  // spreading money across lines worth nothing.
  if (total <= 0) return alloc;

  // Never allocate more than the bill is worth — a discount larger than the
  // subtotal zeroes the bill, it does not create a negative line.
  const cap = Math.round(total * 100);
  let remaining = Math.min(cents, cap);

  const shares = eligible.map((l) => {
    const exact = (remaining * l.gross) / total;
    const floor = Math.floor(exact);
    return { index: l.index, floor, frac: exact - floor };
  });
  let assigned = shares.reduce((s, x) => s + x.floor, 0);
  // Hand out the leftover cents to the largest fractional parts first; ties go to
  // the earlier line so the result is deterministic for a given basket.
  const order = [...shares].sort((a, b) => b.frac - a.frac || a.index - b.index);
  let i = 0;
  while (assigned < remaining && order.length > 0) {
    order[i % order.length].floor += 1;
    assigned += 1;
    i += 1;
  }
  for (const sh of shares) alloc[sh.index] = sh.floor / 100;
  remaining = 0;
  return alloc;
}

export function basketTotals(
  items: BasketLine[],
  discount?: { type?: "percent" | "amount" | null; value?: number | null },
  usdToLbp: number = CLINIC.defaultUsdToLbp,
): { subtotal: number; discount: number; total: number } {
  const subtotal = items.reduce((sum, i) => sum + basketLineUsd(i, usdToLbp), 0);
  const amount = discountAmount(subtotal, discount?.type, discount?.value);
  return { subtotal, discount: amount, total: Math.max(0, subtotal - amount) };
}

/**
 * Adds a secretary-added basket line, merging it into an existing matching added
 * line — same kind + label + unit price + currency, both editable and uncovered —
 * by summing quantity, so adding the same item twice reads as one line ×N rather
 * than two duplicate rows. The dietitian's `sent` lines (collected exactly as
 * sent) and covered lines are never merged into, so an add lands beside them as
 * its own editable line. Returns a new array; never mutates the input.
 */
export function mergeAddedBasketItem<
  T extends {
    kind: string;
    label: string;
    unitPrice: number;
    currency: string;
    quantity: number;
    covered: boolean;
    sent: boolean;
  },
>(items: T[], addition: T): T[] {
  const idx = items.findIndex(
    (i) =>
      !i.sent &&
      !i.covered &&
      i.kind === addition.kind &&
      i.label.trim().toLowerCase() === addition.label.trim().toLowerCase() &&
      i.unitPrice === addition.unitPrice &&
      i.currency === addition.currency,
  );
  if (idx === -1) return [...items, addition];
  return items.map((i, n) =>
    n === idx ? { ...i, quantity: i.quantity + addition.quantity } : i,
  );
}

export function calcBmi(weightKg?: number, heightCm?: number): number | undefined {
  if (!weightKg || !heightCm) return undefined;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function bmiCategory(bmi?: number): string {
  if (!bmi) return "—";
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

export function age(dob?: string): number | undefined {
  if (!dob) return undefined;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

export function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

/**
 * Builds a CSV from an array of records and triggers a browser download.
 *
 * A leading `= + - @` (or tab) makes Excel/Sheets/LibreOffice read the cell as
 * a formula when the file is opened — CSV/formula injection (CWE-1236) — and
 * quoting alone does NOT stop it, spreadsheet apps evaluate formulas in quoted
 * fields too. Patient/referrer names are free text with no character
 * allowlist (a name like `=HYPERLINK(...)` passes validation fine), so any
 * cell could carry one. Prefixing a bare `'` neutralizes it the standard
 * (OWASP) way: Excel shows the literal text instead of evaluating it.
 */
const FORMULA_TRIGGER = /^[=+\-@\t]/;
const csvEscape = (v: unknown) => {
  let s = String(v ?? "");
  if (FORMULA_TRIGGER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

function csvBlock(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ];
}

/**
 * Saves a CSV. Returns FALSE when there was nothing to save.
 *
 * The return value is the point: this used to return silently on empty input
 * while the caller went ahead and announced a successful export, so a user with
 * no data was told a file had been written that never was.
 *
 * The blob opens with a UTF-8 BOM. Without it Excel decodes the file as the local
 * ANSI codepage and every Arabic patient name arrives as mojibake — the one
 * failure mode that makes an export worthless to this clinic specifically.
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): boolean {
  return downloadCsvSections(filename, [{ title: "", rows }]);
}

/**
 * Saves several tables into one CSV, each under its own title row and separated
 * by a blank line — the shape a spreadsheet opens without complaint.
 *
 * A report is more than its largest table. Exporting only one of them and calling
 * it "the report" is how a number that exists on screen turns out to be missing
 * from the file someone is reconciling against.
 */
export function downloadCsvSections(
  filename: string,
  sections: { title: string; rows: Record<string, unknown>[] }[],
): boolean {
  const blocks = sections
    .map((s) => ({ title: s.title, lines: csvBlock(s.rows) }))
    .filter((b) => b.lines.length > 0);
  if (blocks.length === 0) return false;

  const csv = blocks
    .map((b) => (b.title ? [csvEscape(b.title), ...b.lines] : b.lines).join("\n"))
    .join("\n\n");

  const url = URL.createObjectURL(
    new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}
