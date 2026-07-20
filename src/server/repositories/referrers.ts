import { db } from "../db";
import { toReferrer } from "../serialize";
import { NotFoundError } from "../http";
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
    data: { name: input.name, active: input.active ?? true },
  });
  return toReferrer(row);
}

export async function updateReferrer(id: string, input: UpdateReferrerInput): Promise<Referrer> {
  const existing = await db.referrer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Referrer not found");
  const row = await db.referrer.update({
    where: { id },
    data: { name: input.name ?? undefined, active: input.active ?? undefined },
  });
  return toReferrer(row);
}

export async function deleteReferrer(id: string): Promise<void> {
  const existing = await db.referrer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Referrer not found");
  await db.referrer.delete({ where: { id } });
}
