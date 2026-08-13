import { Prisma } from "@prisma/client";
import { db } from "../db";
import { CLINIC } from "@/lib/config";
import { ConflictError } from "../http";
import {
  FX_RATE_CURRENCY,
  FX_RATE_KEYS,
  assertUsableFxRate,
  describeSuspicion,
  detectSuspiciousRateChange,
  formatFxRate,
  type FxRateKey,
  type FxSuspicion,
  type TenderCurrency,
} from "@/lib/money";
import { writeAudit } from "./audit";
import type { FxRateChangeEntry } from "@/lib/types";

export interface Settings {
  usdToLbp: number;
  usdToEur: number;
  // Admin-set fee added to a card payment (e.g. 10 = 10%). 0 (the default when
  // unset) disables the surcharge entirely.
  cardSurchargePercent: number;
}

/** Reads clinic settings, falling back to defaults when a key isn't set yet. */
export async function getSettings(): Promise<Settings> {
  const rows = await db.setting.findMany({
    where: { key: { in: ["usdToLbp", "usdToEur", "cardSurchargePercent"] } },
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  // Settings are free-text rows, so a stored value can be anything a past write
  // (or a hand edit) left behind. `> 0` alone accepts Infinity, which would value
  // every foreign payment at $0 — silently. Both rates are therefore validated
  // against the same sanity bounds `fxRateFor` enforces, and fall back to the
  // documented clinic default when unusable rather than propagating a poison value.
  const usable = (raw: number, currency: TenderCurrency, fallback: number) => {
    try {
      assertUsableFxRate(currency, raw);
      return raw;
    } catch {
      return fallback;
    }
  };
  const usdToLbp = usable(byKey.usdToLbp, "LBP", CLINIC.defaultUsdToLbp);
  const usdToEur = usable(byKey.usdToEur, "EUR", CLINIC.defaultUsdToEur);
  const cardSurchargePercent =
    Number.isFinite(byKey.cardSurchargePercent) && byKey.cardSurchargePercent >= 0
      ? byKey.cardSurchargePercent
      : 0;
  return { usdToLbp, usdToEur, cardSurchargePercent };
}

/** Returns just the USD→LBP rate, used server-side to convert totals. */
export async function getUsdToLbp(): Promise<number> {
  return (await getSettings()).usdToLbp;
}

/**
 * Raised when a rate change is a large enough jump to look like a typo. Carries
 * the machine-readable detail the UI needs to render a confirmation prompt, and
 * `code: "fx_rate_confirmation_required"` so the typed client can tell it apart
 * from an ordinary conflict. NOTHING is written when this is thrown.
 */
export class SuspiciousRateError extends Error {
  suspicions: FxSuspicion[];
  constructor(suspicions: FxSuspicion[]) {
    super(suspicions.map(describeSuspicion).join(" "));
    this.name = "SuspiciousRateError";
    this.suspicions = suspicions;
  }
}

/** The rate keys, read straight from the Setting rows (no defaults applied), so a
 * comparison is against what is actually STORED rather than a fallback. */
async function storedRates(
  client: Prisma.TransactionClient,
): Promise<Partial<Record<FxRateKey, number>>> {
  const rows = await client.setting.findMany({ where: { key: { in: [...FX_RATE_KEYS] } } });
  const out: Partial<Record<FxRateKey, number>> = {};
  for (const r of rows) {
    const n = Number(r.value);
    if (Number.isFinite(n) && n > 0) out[r.key as FxRateKey] = n;
  }
  return out;
}

export type UpdateSettingsInput = {
  usdToLbp?: number;
  usdToEur?: number;
  cardSurchargePercent?: number;
  /**
   * Explicit admin acknowledgement of a suspicious change. This is NOT a "skip
   * the check" flag: the server re-detects the suspicion from the values it reads
   * itself and only honours the acknowledgement when the confirmed value matches
   * the value being submitted, so a client that simply sets it cannot slip a
   * different number through (see `confirmSuspicious` handling below).
   */
  confirmSuspicious?: Partial<Record<FxRateKey, number>>;
  /** Verified acting user — resolved by the route from the session, never sent. */
  actorId?: string | null;
  actorName?: string | null;
};

/**
 * Updates clinic settings, recording an append-only history entry for every rate
 * that actually MOVES.
 *
 * Everything runs in one transaction: the old value is read, the new value is
 * written, and both the `FxRateChange` row and the shared audit line commit with
 * it — so a rate can never change without its history, and a rejected change can
 * never leave a history row behind.
 */
export async function updateSettings(input: UpdateSettingsInput): Promise<Settings> {
  // Re-validate here as well as in the schema: this is the repository every write
  // path goes through, and an unusable rate persisted from any of them would
  // silently mis-value every subsequent foreign payment.
  if (input.usdToLbp !== undefined) assertUsableFxRate("LBP", input.usdToLbp);
  if (input.usdToEur !== undefined) assertUsableFxRate("EUR", input.usdToEur);

  const proposed: Partial<Record<FxRateKey, number>> = {};
  if (input.usdToLbp !== undefined) proposed.usdToLbp = input.usdToLbp;
  if (input.usdToEur !== undefined) proposed.usdToEur = input.usdToEur;

  await db.$transaction(async (tx) => {
    // Serialize rate edits against each other. Without this, two concurrent
    // updates both read the same "before" under READ COMMITTED and both write a
    // history row claiming it — so an auditor would see 0.92 -> 1.00 and
    // 0.92 -> 1.10 for what was really 0.92 -> 1.00 -> 1.10, with no record that
    // the value ever passed through the first. The history would be a plausible
    // lie, which is worse than no history at all.
    //
    // A transaction-scoped advisory lock is the right primitive here: SELECT FOR
    // UPDATE cannot lock a Setting row that does not exist yet (the first-ever
    // set), and this releases automatically on commit or rollback. Editing an
    // exchange rate is a rare admin action, so serializing it costs nothing.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('nutriclinic:fx_rate_update'))`;

    // Read the CURRENT stored values inside the transaction — behind the lock, so
    // `oldValue` is provably what was there at the moment of this change.
    const current = await storedRates(tx);

    // --- Suspicious-change gate -------------------------------------------------
    // Detected from server-read values only. An acknowledgement counts solely when
    // it names the SAME number now being saved: if the admin was warned about 92
    // and then submits 920 with the old confirmation attached, the confirmation
    // does not apply and they are warned again.
    const suspicions: FxSuspicion[] = [];
    for (const key of FX_RATE_KEYS) {
      const next = proposed[key];
      if (next === undefined) continue;
      const suspicion = detectSuspiciousRateChange(key, current[key], next);
      if (!suspicion) continue;
      const confirmed = input.confirmSuspicious?.[key];
      if (confirmed !== undefined && confirmed === next) continue;
      suspicions.push(suspicion);
    }
    if (suspicions.length > 0) throw new SuspiciousRateError(suspicions);

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    const upsert = (key: string, value: number) =>
      tx.setting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      });

    for (const key of FX_RATE_KEYS) {
      const next = proposed[key];
      if (next === undefined) continue;
      const prev = current[key];
      // A no-op submit writes no history. The Pricing form posts both rates
      // together, so without this every LBP edit would also log a phantom EUR
      // "change" from 0.92 to 0.92 and bury the real ones.
      if (prev !== undefined && prev === next) continue;

      const overrode = suspiciousOverrideFor(key, prev, next, input.confirmSuspicious);
      await upsert(key, next);
      await tx.fxRateChange.create({
        data: {
          rateKey: key,
          oldValue: prev ?? null,
          newValue: next,
          suspiciousOverride: overrode,
          changedById: input.actorId ?? null,
          changedByName: input.actorName ?? "Unknown user",
        },
      });
      // Also land it in the shared audit log, where accountability events are
      // already looked for — same dual-write pattern the Jessy ledger uses.
      const currency = FX_RATE_CURRENCY[key];
      await writeAudit(tx, {
        userId: input.actorId ?? null,
        userName: input.actorName,
        action: "Exchange rate changed",
        entityType: "FxRate",
        entityLabel:
          `${prev === undefined ? "(unset)" : formatFxRate(currency, prev)} → ` +
          `${formatFxRate(currency, next)}${overrode ? " — SUSPICIOUS CHANGE CONFIRMED BY ADMIN" : ""}`,
      });
    }

    if (input.cardSurchargePercent !== undefined) {
      writes.push(upsert("cardSurchargePercent", input.cardSurchargePercent));
    }
    await Promise.all(writes);
  });

  return getSettings();
}

/** Whether this specific change was a suspicious one the admin explicitly confirmed. */
function suspiciousOverrideFor(
  key: FxRateKey,
  prev: number | undefined,
  next: number,
  confirmed: Partial<Record<FxRateKey, number>> | undefined,
): boolean {
  return (
    detectSuspiciousRateChange(key, prev, next) !== null && confirmed?.[key] === next
  );
}

/**
 * The rate-change history, newest first. Admin-only at the route — it is a
 * financial audit trail, and there is deliberately no write, update or delete
 * path to it anywhere in the application.
 */
export async function listFxRateChanges(limit = 200): Promise<FxRateChangeEntry[]> {
  const rows = await db.fxRateChange.findMany({
    orderBy: { changedAt: "desc" },
    take: Math.min(Math.max(1, limit), 500),
  });
  return rows.map((r) => {
    if (!isSupportedRateKey(r.rateKey)) {
      // Blocked by a CHECK constraint; refuse rather than mislabel the history.
      throw new ConflictError(`Rate history contains an unknown rate key: ${r.rateKey}`);
    }
    return {
      id: r.id,
      rateKey: r.rateKey,
      currency: FX_RATE_CURRENCY[r.rateKey],
      oldValue: r.oldValue ?? undefined,
      newValue: r.newValue,
      suspiciousOverride: r.suspiciousOverride,
      changedByName: r.changedByName,
      changedAt: r.changedAt.toISOString(),
    };
  });
}

function isSupportedRateKey(v: string): v is FxRateKey {
  return (FX_RATE_KEYS as readonly string[]).includes(v);
}
