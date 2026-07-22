import { db } from "../db";
import { CLINIC } from "@/lib/config";

export interface Settings {
  usdToLbp: number;
  usdToEur: number;
}

/** Reads clinic settings, falling back to defaults when a key isn't set yet. */
export async function getSettings(): Promise<Settings> {
  const rows = await db.setting.findMany({ where: { key: { in: ["usdToLbp", "usdToEur"] } } });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  const usdToLbp = byKey.usdToLbp > 0 ? byKey.usdToLbp : CLINIC.defaultUsdToLbp;
  const usdToEur = byKey.usdToEur > 0 ? byKey.usdToEur : CLINIC.defaultUsdToEur;
  return { usdToLbp, usdToEur };
}

/** Returns just the USD→LBP rate, used server-side to convert totals. */
export async function getUsdToLbp(): Promise<number> {
  return (await getSettings()).usdToLbp;
}

export async function updateSettings(input: {
  usdToLbp?: number;
  usdToEur?: number;
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
  await Promise.all(upserts);
  return getSettings();
}
