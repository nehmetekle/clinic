import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency, toSessionPlan } from "../serialize";
import { getUsdToLbp } from "./settings";
import type { SessionPlan } from "@/lib/types";

/**
 * Pay-as-you-go session plans — a SEPARATE system from fixed-price Packages.
 * A package is a prepaid lump for a fixed number of sessions (unchanged); a
 * session plan tracks running counts (needed / used / paid) so what a client owes
 * can vary visit to visit, with prepaid-but-unused sessions carried as credit.
 */
export async function listSessionPlans(clientId?: string): Promise<SessionPlan[]> {
  const rows = await db.sessionPlan.findMany({
    where: clientId ? { clientId } : undefined,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toSessionPlan);
}

export async function getSessionPlan(id: string): Promise<SessionPlan | null> {
  const row = await db.sessionPlan.findUnique({ where: { id } });
  return row ? toSessionPlan(row) : null;
}

export async function createSessionPlan(input: {
  clientId: string;
  machine: string;
  sessionsNeeded: number;
}): Promise<SessionPlan> {
  const client = await db.client.findUnique({
    where: { id: input.clientId },
    select: { id: true },
  });
  if (!client) throw new NotFoundError("Client not found");

  const machine = input.machine.trim();
  // F4: the per-session price is snapshotted from the admin-managed ServicePrice
  // catalog for this treatment — NEVER taken from the request — so a dietitian
  // can't set an off-catalog price. To charge less, they apply a logged discount.
  const service = await db.servicePrice.findFirst({
    where: { kind: "treatment", key: machine, active: true },
    select: { price: true, currency: true },
  });
  if (!service) {
    throw new ConflictError(`No active catalog price for treatment "${machine}".`);
  }

  const row = await db.sessionPlan.create({
    data: {
      clientId: input.clientId,
      machine,
      unitPrice: service.price,
      currency: asCurrency(service.currency),
      // Freeze the live rate onto the plan, like every other financial record.
      usdToLbp: await getUsdToLbp(),
      sessionsNeeded: Math.max(1, Math.floor(input.sessionsNeeded)),
    },
  });
  return toSessionPlan(row);
}
