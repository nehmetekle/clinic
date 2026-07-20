import { db } from "../db";
import { NotFoundError } from "../http";
import { toPackage } from "../serialize";
import type { Package } from "@/lib/types";
import type { CreatePackageInput, UpdatePackageInput } from "@/lib/validation";

export async function listPackages(): Promise<Package[]> {
  const rows = await db.package.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toPackage);
}

export async function createPackage(input: CreatePackageInput): Promise<Package> {
  const row = await db.package.create({
    data: {
      name: input.name,
      description: input.description,
      price: input.price,
      cost: input.cost ?? 0,
      currency: input.currency ?? "USD",
      sessions: input.sessions,
      discountPercent: input.discountPercent ?? 0,
      status: input.status ?? "active",
      machine: input.machine ?? null,
    },
  });
  return toPackage(row);
}

/**
 * Full package edit. Every field is optional; only the provided ones change.
 * Changing `price`/`cost`/details updates the catalog everywhere it is read —
 * already-sold client packages keep their purchase-time snapshot (by design).
 */
export async function updatePackage(
  id: string,
  input: UpdatePackageInput,
): Promise<Package> {
  const existing = await db.package.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Package not found");

  const row = await db.package.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      price: input.price ?? undefined,
      cost: input.cost ?? undefined,
      currency: input.currency ?? undefined,
      sessions: input.sessions ?? undefined,
      discountPercent: input.discountPercent ?? undefined,
      status: input.status ?? undefined,
    },
  });
  return toPackage(row);
}
