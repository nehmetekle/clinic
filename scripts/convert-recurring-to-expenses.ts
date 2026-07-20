/**
 * One-off migration: convert legacy `RecurringExpense` templates into real, dated
 * one-off `Expense` rows, then delete the templates.
 *
 * WHY: the recurring-cost mechanism (templates + on-the-fly monthly accrual) has
 * been retired. This preserves the history any real database accrued under it by
 * materialising one dated Expense per accrued month, using the SAME frozen amount
 * the old accrual read for that month (from the template's `periods` snapshots) —
 * so all-time totals don't shift.
 *
 * Reads `RecurringExpense` via raw SQL (the model no longer exists in the Prisma
 * schema) and writes `Expense` via the client. Idempotent: it deletes the
 * templates in the same transaction as the inserts, so a second run finds none
 * and does nothing. Safe to run against a DB that has no `RecurringExpense` table
 * or no rows — it reports "nothing to convert" and exits 0.
 *
 * Accrual horizon: months from each template's first period through the "as of"
 * month (env `CONVERT_AS_OF_MONTH=YYYY-MM`, default = current calendar month).
 * Set it to the month the app treated as "today" to reproduce its totals exactly.
 *
 *   Usage:  DATABASE_URL=file:./prod.db \
 *           CONVERT_AS_OF_MONTH=2026-06 \
 *           npx tsx scripts/convert-recurring-to-expenses.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Period = { month: string; amount: number; currency: string; usdToLbp: number };

type TemplateRow = {
  id: string;
  title: string;
  amount: number;
  currency: string;
  usdToLbp: number;
  periods: string;
  startDate: unknown;
};

const asOfMonth = process.env.CONVERT_AS_OF_MONTH ?? new Date().toISOString().slice(0, 7);

/** Inclusive list of YYYY-MM keys from start to end (empty if start is after end). */
function monthKeysBetween(startKey: string, endKey: string): string[] {
  const [sy, sm] = startKey.split("-").map(Number);
  const [ey, em] = endKey.split("-").map(Number);
  const keys: string[] = [];
  for (let n = sy * 12 + (sm - 1); n <= ey * 12 + (em - 1); n++) {
    keys.push(`${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

function parsePeriods(json: string): Period[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function startMonthOf(row: TemplateRow, periods: Period[]): string {
  if (periods.length > 0) return periods[0].month;
  // Legacy fallback: derive from startDate (Date, ISO string, or epoch ms/s).
  const v = row.startDate;
  const dt =
    v instanceof Date ? v : typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return dt.toISOString().slice(0, 7);
}

/** The frozen cost in effect for `month` — mirrors the retired dashboard accrual. */
function costForMonth(
  row: TemplateRow,
  periods: Period[],
  month: string,
): { amount: number; currency: string; usdToLbp: number } | null {
  if (periods.length === 0) {
    return startMonthOf(row, periods) <= month
      ? { amount: row.amount, currency: row.currency, usdToLbp: row.usdToLbp }
      : null;
  }
  let chosen: Period | null = null;
  for (const p of periods) {
    if (p.month <= month && (!chosen || p.month > chosen.month)) chosen = p;
  }
  return chosen ? { amount: chosen.amount, currency: chosen.currency, usdToLbp: chosen.usdToLbp } : null;
}

function monthLabel(monthKey: string): string {
  return new Date(`${monthKey}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function main() {
  let templates: TemplateRow[];
  try {
    // CAST startDate to TEXT so the raw read never trips Prisma's DateTime
    // deserialization (the month we actually need comes from `periods`).
    templates = await prisma.$queryRawUnsafe<TemplateRow[]>(
      "SELECT id, title, amount, currency, usdToLbp, periods, CAST(startDate AS TEXT) AS startDate FROM RecurringExpense",
    );
  } catch {
    console.log("No RecurringExpense table found — nothing to convert.");
    return;
  }

  if (templates.length === 0) {
    console.log("No RecurringExpense templates found — nothing to convert.");
    return;
  }

  console.log(`Converting ${templates.length} recurring template(s), accruing through ${asOfMonth}…`);

  const toCreate: {
    title: string;
    amount: number;
    currency: string;
    usdToLbp: number;
    date: Date;
    notes: string;
  }[] = [];

  for (const t of templates) {
    const periods = parsePeriods(t.periods);
    const startKey = startMonthOf(t, periods);
    const months = monthKeysBetween(startKey, asOfMonth);
    let created = 0;
    for (const month of months) {
      const cost = costForMonth(t, periods, month);
      if (!cost) continue;
      toCreate.push({
        title: `${t.title} — ${monthLabel(month)}`,
        amount: cost.amount,
        currency: cost.currency,
        usdToLbp: cost.usdToLbp,
        date: new Date(`${month}-01T00:00:00Z`),
        notes: "Converted from a retired fixed monthly cost.",
      });
      created++;
    }
    console.log(`  ${t.title}: ${created} dated expense row(s) [${months[0] ?? "—"}…${asOfMonth}]`);
  }

  const total = toCreate.reduce((s, e) => s + e.amount, 0);

  // Inserts + template deletion in ONE transaction: if anything fails it all rolls
  // back, so a retry starts clean and never double-converts.
  await prisma.$transaction(async (tx) => {
    for (const e of toCreate) {
      await tx.expense.create({
        data: {
          title: e.title,
          amount: e.amount,
          currency: e.currency,
          usdToLbp: e.usdToLbp,
          date: e.date,
          method: "cash",
          notes: e.notes,
        },
      });
    }
    await tx.$executeRawUnsafe("DELETE FROM RecurringExpense");
  });

  console.log(
    `Done: created ${toCreate.length} Expense row(s) totalling ${total} (mixed currencies summed raw), ` +
      `removed ${templates.length} template(s).`,
  );
}

main()
  .catch((e) => {
    console.error("Conversion failed (no changes committed):", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
