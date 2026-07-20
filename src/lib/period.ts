// Period presets for the dashboard/reports finance filters. Every cost and
// payment is a real dated row, so a period is just an inclusive [from, to] date
// window; the server sums the rows that fall inside it.

export const PERIOD_PRESETS = [
  "Today",
  "This week",
  "This month",
  "Last month",
  "Custom",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive [from, to] (YYYY-MM-DD) for a preset, relative to `today`. The week
 * starts Monday. "This week"/"This month" run up to today; "Last month" is the
 * whole previous calendar month. "Custom" passes the caller's picked dates
 * through (empty → the server treats that bound as open).
 */
export function periodRange(
  preset: PeriodPreset,
  today: string,
  custom?: { from?: string; to?: string },
): { from: string; to: string } {
  const t = new Date(`${today}T00:00:00Z`);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (preset) {
    case "Today":
      return { from: today, to: today };
    case "This week": {
      const diffToMon = (t.getUTCDay() + 6) % 7; // days since Monday
      const start = new Date(t);
      start.setUTCDate(t.getUTCDate() - diffToMon);
      return { from: iso(start), to: today };
    }
    case "This month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today };
    case "Last month": {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0)); // day 0 of this month = last day of previous
      return { from: iso(start), to: iso(end) };
    }
    case "Custom":
      return { from: custom?.from ?? "", to: custom?.to ?? "" };
  }
}

/** Short human label for a range, e.g. "Jun 1 – Jun 15, 2026" or "All time". */
export function rangeLabel(from: string, to: string): string {
  if (!from && !to) return "All time";
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  if (from && to) return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
  return from ? `From ${fmt(from)}` : `Until ${fmt(to)}`;
}
