/**
 * Clinic-wide configuration. In production these settings would come from the DB.
 */
export const CLINIC = {
  name: "NutriClinic",
  currency: "USD",
  // Fallback exchange rate; the live value is stored in the DB (Setting "usdToLbp")
  // and editable from the Settings page.
  defaultUsdToLbp: 89500,
  // Fallback USD→EUR rate (1 USD = ? EUR); live value stored in Setting "usdToEur",
  // editable from the Pricing page. Display/reference only for now — not yet a
  // transaction currency, so it is not frozen onto any record.
  defaultUsdToEur: 0.92,
  // The clinic's physical timezone. "Today", the queue, appointment scheduling,
  // every date-based filter/report, AND all date display are anchored to THIS
  // zone — never the runtime's own — so an admin logging in from the US sees the
  // exact same day, queue and day boundaries as staff physically at the clinic.
  // IANA name; override with NEXT_PUBLIC_CLINIC_TIMEZONE (must be a build-time env
  // var so the value is inlined into the client bundle too). DST is handled
  // automatically by Intl.
  timeZone: process.env.NEXT_PUBLIC_CLINIC_TIMEZONE || "Asia/Beirut",
};

// Reserved referrer value meaning "no one referred them — the patient came to the
// clinic organically (walk-in / self-referred)". A real, explicit choice offered
// in every referrer dropdown, distinct from a blank/unanswered field. It never
// carries a commission: resolveReferralFee() short-circuits it to no fee even if a
// referrer literally named "None" exists, so organic patients are never a cost.
export const NONE_REFERRER = "None";

const pad2 = (n: number) => String(n).padStart(2, "0");

// One Intl formatter per timezone (built lazily, cached) — the calendar-day parts
// of an instant as seen in that zone.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/**
 * The calendar day (`YYYY-MM-DD`) of an instant in the CLINIC's timezone. Built on
 * `Intl` with an explicit `timeZone`, so it returns the identical day no matter
 * what timezone the runtime is in — a server host on UTC, a browser in Los
 * Angeles, and a browser in Beirut all get the clinic's day. This is the app's
 * SINGLE source of truth for "what day is it": used both for "today" and for
 * serializing every stored timestamp to its day (see serialize.dateOnly).
 */
export function clinicDay(date: Date = new Date()): string {
  const parts = dayFormatter(CLINIC.timeZone).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Today's date as a `YYYY-MM-DD` string in the clinic's timezone — the app's
 * "current day" for the queue, dashboards, scheduling and default form dates.
 */
export function todayIso(): string {
  return clinicDay();
}

/** Minutes the clinic wall-clock is ahead of UTC at `date` (negative if behind);
 * reflects DST at that instant. */
function clinicOffsetMinutes(date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/** The UTC instant of clinic-midnight that opens the given clinic-day. */
function clinicDayStart(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  let utcMs = Date.UTC(y, m - 1, d);
  // Correct the UTC guess by the zone offset, re-checking once so a DST changeover
  // right at the boundary still resolves to the true local midnight.
  for (let i = 0; i < 2; i++) {
    const corrected = Date.UTC(y, m - 1, d) - clinicOffsetMinutes(new Date(utcMs)) * 60000;
    if (corrected === utcMs) break;
    utcMs = corrected;
  }
  return new Date(utcMs);
}

/**
 * Half-open `[gte, lt)` UTC instant range spanning one clinic-day, for Prisma
 * `date` filters. Selects exactly the rows whose `clinicDay()` equals `day` —
 * including a row stored at an instant that lands on a different UTC day (e.g. a
 * visit recorded just after clinic-midnight). Replaces naive UTC-midnight ranges.
 */
export function clinicDayRange(day: string): { gte: Date; lt: Date } {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)); // JS normalizes month/year overflow
  const nextDay = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
  return { gte: clinicDayStart(day), lt: clinicDayStart(nextDay) };
}

/** Minutes since clinic-midnight for `date`, in clinic time — for "next slot"
 * defaults that must follow the clinic clock, not the booker's device clock. */
export function clinicMinutesOfDay(date: Date = new Date()): number {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (((utcMinutes + clinicOffsetMinutes(date)) % 1440) + 1440) % 1440;
}

/** The clinic-local time-of-day ("HH:MM") of an instant — for a time <input>. */
export function clinicTimeInput(iso: string): string {
  const mins = clinicMinutesOfDay(new Date(iso));
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

/** ISO instant for clinic-local time-of-day ("HH:MM") on the clinic-day that
 * `iso` falls on — the inverse of clinicTimeInput, so editing a sample's time
 * sets it in clinic time regardless of the editor's own timezone. */
export function withClinicTime(iso: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const start = clinicDayStart(clinicDay(new Date(iso))).getTime();
  return new Date(start + (h * 60 + m) * 60000).toISOString();
}

/** Message shown in the UI and returned by the server when a weekend booking
 * is attempted. Single source so the client picker and Zod schemas agree. */
export const WEEKEND_BOOKING_MESSAGE =
  "Weekends can't be booked — the clinic is closed on Saturday and Sunday.";

/**
 * True when a local `YYYY-MM-DD` date string falls on a Saturday or Sunday.
 * The clinic is closed on weekends, so no appointment (or next-visit) date may
 * land on one. Parses at local midnight (not UTC) so the weekday is correct
 * regardless of timezone. An empty string is treated as "not a weekend" so
 * optional/unset fields pass.
 */
export function isWeekendIso(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const day = new Date(`${iso}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

/** Converts an amount to USD using the given rate (1 USD = rate LBP). */
export function toUsd(amount: number, currency: string, usdToLbp: number): number {
  return currency === "LBP" ? amount / usdToLbp : amount;
}

/**
 * USD value of a financial record, using the exchange rate FROZEN on that record
 * when it was logged. USD is the single source of truth for all totals, so LBP
 * records fold into the same USD figure at their frozen rate.
 *
 * If an LBP record has no frozen rate (snapshotRate ≤ 0), we still fall back to the
 * live rate so nothing breaks — but that record's reported USD value would then
 * silently drift whenever the live rate changes. Every write path freezes the rate,
 * so this should never happen; when it does we surface it loudly in development
 * (R4) instead of re-pricing history in silence. USD records are rate-independent,
 * so a missing rate on them is harmless (no warning).
 */
export function toUsdFrozen(
  amount: number,
  currency: string,
  snapshotRate: number,
  fallbackRate: number,
): number {
  if (currency === "LBP" && snapshotRate <= 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[usdToLbp] LBP amount ${amount} has no frozen exchange rate — falling back to the live rate ` +
        `(${fallbackRate}). Its reported USD value can drift when the rate changes; backfill this record's usdToLbp.`,
    );
  }
  return toUsd(amount, currency, snapshotRate > 0 ? snapshotRate : fallbackRate);
}
