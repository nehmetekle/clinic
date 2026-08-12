import { db } from "../db";
import { CLINIC } from "@/lib/config";

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
  const usdToLbp = byKey.usdToLbp > 0 ? byKey.usdToLbp : CLINIC.defaultUsdToLbp;
  const usdToEur = byKey.usdToEur > 0 ? byKey.usdToEur : CLINIC.defaultUsdToEur;
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

export async function updateSettings(input: {
  usdToLbp?: number;
  usdToEur?: number;
  cardSurchargePercent?: number;
}): Promise<Settings> {
  const upserts = [];
  if (input.usdToLbp !== undefined) {
    upserts.push(
      db.setting.upsert({
        where: { key: "usdToLbp" },
        create: { key: "usdToLbp", value: String(input.usdToLbp) },
        update: { value: String(input.usdToLbp) },
      }),
    );
  }
  if (input.usdToEur !== undefined) {
    upserts.push(
      db.setting.upsert({
        where: { key: "usdToEur" },
        create: { key: "usdToEur", value: String(input.usdToEur) },
        update: { value: String(input.usdToEur) },
      }),
    );
  }
  if (input.cardSurchargePercent !== undefined) {
    upserts.push(
      db.setting.upsert({
        where: { key: "cardSurchargePercent" },
        create: { key: "cardSurchargePercent", value: String(input.cardSurchargePercent) },
        update: { value: String(input.cardSurchargePercent) },
      }),
    );
  }
  await Promise.all(upserts);
  return getSettings();
}
