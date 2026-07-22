import { db } from "../db";
import { toReferrer } from "../serialize";
import { NotFoundError } from "../http";
import { NONE_REFERRER } from "@/lib/config";
import type { Referrer } from "@/lib/types";
import type { CreateReferrerInput, UpdateReferrerInput } from "@/lib/validation";

/** Active referrers first, then alphabetical — used by the registration dropdowns. */
export async function listReferrers(): Promise<Referrer[]> {
  const rows = await db.referrer.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return rows.map(toReferrer);
}

export async function createReferrer(input: CreateReferrerInput): Promise<Referrer> {
  const row = await db.referrer.create({
    data: { name: input.name, active: input.active ?? true, fee: input.fee ?? 0 },
  });
  return toReferrer(row);
}

export async function updateReferrer(id: string, input: UpdateReferrerInput): Promise<Referrer> {
  const existing = await db.referrer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Referrer not found");
  const row = await db.referrer.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      active: input.active ?? undefined,
      fee: input.fee ?? undefined,
    },
  });
  return toReferrer(row);
}

/**
 * The commission (USD) to freeze onto a patient when they're attributed to the
 * referrer named `referralSource`. Matches the LIVE Referrer.fee by the exact
 * snapshotted name (the same free-text name stored on the client), so the amount
 * is captured once, at registration, and never re-derived afterwards. Returns
 * null when there's no referrer match or the fee is 0 — i.e. nothing to owe.
 */
export async function resolveReferralFee(
  referralSource: string | null | undefined,
): Promise<number | null> {
  const name = referralSource?.trim();
  // No referrer, or the explicit "None" (came organically) choice → never a cost.
  if (!name || name === NONE_REFERRER) return null;
  const referrer = await db.referrer.findFirst({ where: { name } });
  const fee = referrer?.fee ?? 0;
  return fee > 0 ? fee : null;
}

export async function deleteReferrer(id: string): Promise<void> {
  const existing = await db.referrer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Referrer not found");
  await db.referrer.delete({ where: { id } });
}
