import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { toServicePrice } from "../serialize";
import type { ServicePrice } from "@/lib/types";
import type {
  CreateServicePriceInput,
  UpdateServicePriceInput,
} from "@/lib/validation";

/** Blood tests are a fixed set; treatment types are admin-managed (create + edit). */
export async function listServicePrices(): Promise<ServicePrice[]> {
  const rows = await db.servicePrice.findMany({
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map(toServicePrice);
}

/**
 * Creates an admin-defined catalog entry — a treatment type (a "machine") or a
 * blood test (`kind` defaults to treatment). The name doubles as the stable key
 * that consultations store, so it must be unique within its kind and can't be
 * renamed later — deactivate and add a new one instead, which keeps past visits
 * (they store the name) displaying unchanged. Blood tests carry no body parts.
 */
export async function createServicePrice(
  input: CreateServicePriceInput,
): Promise<ServicePrice> {
  const kind = input.kind ?? "treatment";
  const key = input.name.trim();
  // "Other" is the blood-test catalog's fallback bucket for a one-off custom lab
  // test. It is NOT a machine: a treatment must name one of the clinic's actual
  // predefined machines, so a treatment row called "Other" is refused rather than
  // quietly recreating the custom-machine identity that reporting cannot group.
  if (kind === "treatment" && key.toLowerCase() === "other") {
    throw new ConflictError(
      'There is no "Other" machine — add the machine by its real name, or leave the treatment off the visit.',
    );
  }
  const existing = await db.servicePrice.findUnique({
    where: { kind_key: { kind, key } },
  });
  if (existing) {
    const label = kind === "blood_test" ? "blood test" : "treatment type";
    throw new ConflictError(`A ${label} with this name already exists.`);
  }
  const row = await db.servicePrice.create({
    data: {
      kind,
      key,
      name: key,
      price: input.price ?? 0,
      cost: input.cost ?? 0,
      currency: input.currency ?? "USD",
      // Blood tests never carry body-part presets; only treatments do.
      bodyParts:
        kind === "blood_test" || input.bodyParts == null
          ? null
          : JSON.stringify(input.bodyParts),
      active: true,
    },
  });
  return toServicePrice(row);
}

export async function updateServicePrice(
  id: string,
  input: UpdateServicePriceInput,
): Promise<ServicePrice> {
  const existing = await db.servicePrice.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Service price not found");

  // The blood-test "Other" row is the fallback that prices a one-off custom lab
  // test (see priceSnapshot); deactivating it would silently zero out that
  // pricing, so it can never be turned off. Its price/cost stay editable.
  // Treatments have no such bucket — there is no custom machine.
  if (existing.kind === "blood_test" && existing.key === "Other" && input.active === false) {
    throw new ConflictError('The "Other" entry can\'t be deactivated.');
  }

  const row = await db.servicePrice.update({
    where: { id },
    data: {
      price: input.price ?? undefined,
      cost: input.cost ?? undefined,
      currency: input.currency ?? undefined,
      active: input.active ?? undefined,
    },
  });
  return toServicePrice(row);
}
