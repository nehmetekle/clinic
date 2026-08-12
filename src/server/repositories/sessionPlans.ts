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

/**
 * The value of `SessionPlan.activeMachineKey` for a given status/machine — the
 * column the `[clientId, activeMachineKey]` unique index enforces. Set on EVERY
 * write that creates a plan or changes its status, so "one active plan per client
 * per machine" holds in the database and not just in the UI.
 */
export function activeMachineKey(status: string, machine: string | null): string | null {
  return status === "active" ? machine : null;
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

  const sessionsNeeded = Math.max(1, Math.floor(input.sessionsNeeded));

  // One active plan per client per machine: an existing one is REUSED, never
  // duplicated. Raising "sessions needed" on it is what bills the extra sessions
  // (the unpaid balance is the billable quantity); it is never lowered below what
  // the client has already paid for.
  const existing = await db.sessionPlan.findFirst({
    where: { clientId: input.clientId, machine, status: "active" },
  });
  if (existing) {
    const needed = Math.max(sessionsNeeded, existing.sessionsPaid);
    const row =
      needed === existing.sessionsNeeded
        ? existing
        : await db.sessionPlan.update({ where: { id: existing.id }, data: { sessionsNeeded: needed } });
    return toSessionPlan(row);
  }

  const row = await db.sessionPlan.create({
    data: {
      clientId: input.clientId,
      machine,
      activeMachineKey: activeMachineKey("active", machine),
      unitPrice: service.price,
      currency: asCurrency(service.currency),
      // Freeze the live rate onto the plan, like every other financial record.
      usdToLbp: await getUsdToLbp(),
      sessionsNeeded,
    },
  });
  return toSessionPlan(row);
}
