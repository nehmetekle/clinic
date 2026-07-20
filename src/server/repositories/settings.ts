import { db } from "../db";
import { CLINIC } from "@/lib/config";

export interface Settings {
  usdToLbp: number;
}

/** Reads clinic settings, falling back to defaults when a key isn't set yet. */
export async function getSettings(): Promise<Settings> {
  const row = await db.setting.findUnique({ where: { key: "usdToLbp" } });
  const usdToLbp = row ? Number(row.value) : CLINIC.defaultUsdToLbp;
  return { usdToLbp: usdToLbp > 0 ? usdToLbp : CLINIC.defaultUsdToLbp };
}

/** Returns just the USD→LBP rate, used server-side to convert totals. */
export async function getUsdToLbp(): Promise<number> {
  return (await getSettings()).usdToLbp;
}

export async function updateSettings(input: { usdToLbp: number }): Promise<Settings> {
  await db.setting.upsert({
    where: { key: "usdToLbp" },
    create: { key: "usdToLbp", value: String(input.usdToLbp) },
    update: { value: String(input.usdToLbp) },
  });
  return getSettings();
}
