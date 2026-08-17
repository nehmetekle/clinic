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
 * The referrer to ATTRIBUTE a patient to at registration.
 *
 * Attribution only — no money is resolved here and no obligation is created.
 * Registering a patient commits the clinic to nothing; the commission is incurred
 * when that patient's first visit completes, priced at the referrer's rate at
 * THAT moment (see repositories/referralCommissions.ts). This is why there is no
 * fee in the return value: freezing one here would lock a rate months before the
 * obligation it prices exists.
 *
 * The identity IS frozen here, though, and deliberately: who referred the patient
 * is settled at registration and must not follow a later correction to the
 * editable `referralSource` field.
 *
 * Returns nulls for a patient who came organically (the reserved "None" choice)
 * or whose named referrer is not in the catalog — there is nobody to attribute.
 * A zero-fee referrer IS still attributed: the fee is read later, and a rate of 0
 * at registration says nothing about the rate at the first visit.
 */
export async function resolveReferralAttribution(
  referralSource: string | null | undefined,
): Promise<{ referrerId: string | null; referrerName: string | null }> {
  const none = { referrerId: null, referrerName: null };
  const name = referralSource?.trim();
  if (!name || name === NONE_REFERRER) return none;
  // `Referrer.name` is unique, so this resolves to exactly one row or none.
  const referrer = await db.referrer.findFirst({ where: { name } });
  if (!referrer) return none;
  return { referrerId: referrer.id, referrerName: referrer.name };
}

export async function deleteReferrer(id: string): Promise<void> {
  const existing = await db.referrer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Referrer not found");
  await db.referrer.delete({ where: { id } });
}
