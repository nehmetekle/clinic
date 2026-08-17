import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency, toSessionPlan } from "../serialize";
import { auditMoney, writeAudit } from "./audit";
import { getUsdToLbp } from "./settings";
import type { SessionPlan } from "@/lib/types";

/**
 * Session plans — a SEPARATE system from fixed-price Packages, but now built on
 * the same prepaid principle.
 *
 *   sessionsNeeded — the PRESCRIBED course length (clinical intent: "you need 13
 *                    sessions of Cryolipolysis"). Never bills anything by itself.
 *   sessionsPaid   — sessions PURCHASED AND SETTLED. Settling a basket (paid now
 *                    or deferred to a ClientDebt) is what raises this, and that is
 *                    what makes sessions usable.
 *   sessionsUsed   — sessions delivered.
 *   available      — sessionsPaid - sessionsUsed.
 *
 * Sessions are sold as discrete basket lines: from the consultation that
 * prescribes the course, or from the standalone `sellSessions` top-up below. A
 * machine visit only ever consumes `available`; it never bills.
 */
/**
 * Sessions sold on an unsettled STANDALONE sale basket (one not attached to a
 * consultation), per plan. Surfaced on the DTO so the consultation editor's price
 * preview doesn't re-sell sessions the front desk already put on a basket.
 * Consultation-linked pending lines are excluded: those belong to a visit that
 * rebuilds them on every save, and the server nets them out there.
 */
async function pendingStandaloneSalesByPlan(planIds: string[]): Promise<Map<string, number>> {
  if (planIds.length === 0) return new Map();
  const rows = await db.visitBasketItem.groupBy({
    by: ["sessionPlanId"],
    where: {
      sessionPlanId: { in: planIds },
      covered: false,
      basket: { status: "pending", consultationId: null },
    },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.sessionPlanId!, r._sum.quantity ?? 0]));
}

export async function listSessionPlans(clientId?: string): Promise<SessionPlan[]> {
  const rows = await db.sessionPlan.findMany({
    where: clientId ? { clientId } : undefined,
    orderBy: { createdAt: "desc" },
  });
  const pending = await pendingStandaloneSalesByPlan(rows.map((r) => r.id));
  return rows.map((r) => toSessionPlan(r, pending.get(r.id) ?? 0));
}

export async function getSessionPlan(id: string): Promise<SessionPlan | null> {
  const row = await db.sessionPlan.findUnique({ where: { id } });
  if (!row) return null;
  const pending = await pendingStandaloneSalesByPlan([row.id]);
  return toSessionPlan(row, pending.get(row.id) ?? 0);
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

/**
 * Sessions of this plan sitting on an UNSETTLED basket line — already sold, not
 * yet unlocked. `excludeConsultationId` drops the baskets of a consultation that
 * is being rebuilt in this same transaction (its lines are about to be replaced,
 * so counting them would bill the same sessions twice).
 *
 * This is what keeps the two purchase routes from colliding: a top-up sale still
 * awaiting settlement is invisible to `sessionsPaid` but must not be re-billed by
 * the next consultation.
 */
export async function pendingPurchasedSessionsTx(
  tx: Prisma.TransactionClient,
  planId: string,
  excludeConsultationId?: string | null,
): Promise<number> {
  const rows = await tx.visitBasketItem.findMany({
    where: { sessionPlanId: planId, covered: false, basket: { status: "pending" } },
    select: { quantity: true, basket: { select: { consultationId: true } } },
  });
  // The exclusion is applied HERE rather than as a `consultationId: { not: ... }`
  // filter: that compiles to SQL `<>`, which is NULL for a standalone sale basket
  // and would silently drop exactly the rows this function exists to find — the
  // consultation would then re-sell sessions the front desk had already put on a
  // basket.
  return rows
    .filter((r) => !excludeConsultationId || r.basket.consultationId !== excludeConsultationId)
    .reduce((sum, r) => sum + r.quantity, 0);
}

/**
 * The smallest `sessionsNeeded` a plan may hold: everything already bought
 * (settled or awaiting settlement) plus everything already delivered. Trimming
 * below this would either un-sell money that has been collected/committed or
 * leave the plan calling for fewer sessions than the patient has actually had.
 */
export async function sessionPlanNeedsFloorTx(
  tx: Prisma.TransactionClient,
  planId: string,
  excludeConsultationId?: string | null,
): Promise<number> {
  const plan = await tx.sessionPlan.findUnique({
    where: { id: planId },
    select: { sessionsPaid: true, sessionsUsed: true },
  });
  if (!plan) return 0;
  const pending = await pendingPurchasedSessionsTx(tx, planId, excludeConsultationId);
  return Math.max(plan.sessionsPaid + pending, plan.sessionsUsed);
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
    select: { price: true, cost: true, currency: true },
  });
  if (!service) {
    throw new ConflictError(`No active catalog price for treatment "${machine}".`);
  }

  const sessionsNeeded = Math.max(1, Math.floor(input.sessionsNeeded));

  // One active plan per client per machine: an existing one is REUSED, never
  // duplicated. Raising "sessions needed" records a longer prescribed course; it
  // is never lowered below what has already been bought or delivered.
  const existing = await db.sessionPlan.findFirst({
    where: { clientId: input.clientId, machine, status: "active" },
  });
  if (existing) {
    const floor = await sessionPlanNeedsFloorTx(db, existing.id);
    const needed = Math.max(sessionsNeeded, floor);
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
      // F-03: freeze the clinic's own per-session cost alongside the price, from
      // the same catalog row at the same instant. A later catalog cost edit must
      // not be able to rewrite the margin of sessions sold under this plan.
      unitCost: service.cost,
      currency: asCurrency(service.currency),
      // Freeze the live rate onto the plan, like every other financial record.
      usdToLbp: await getUsdToLbp(),
      sessionsNeeded,
    },
  });
  return toSessionPlan(row);
}


export type SellSessionsInput = {
  clientId: string;
  machine: string;
  sessions: number;
};

/**
 * Standalone session sale — the front-desk top-up, with no consultation involved.
 *
 * It reuses the whole existing financial pipeline rather than inventing a second
 * one: it raises the plan's prescribed course by what was bought and drops an
 * ordinary PENDING VisitBasket carrying one session line. The secretary settles
 * that basket the normal way (pay now, or defer the balance to a ClientDebt), and
 * settlement — not this call — is what unlocks the sessions.
 *
 * Nothing here touches `sessionsPaid` or `sessionsUsed`: a sale that is never
 * settled buys nothing.
 */
export async function sellSessions(
  input: SellSessionsInput,
  actor?: { id?: string | null; name?: string | null },
): Promise<{ plan: SessionPlan; basketId: string }> {
  const sessions = Math.floor(input.sessions);
  if (!Number.isFinite(sessions) || sessions < 1) {
    throw new ConflictError("Enter at least one session.");
  }
  const machine = input.machine.trim();
  if (!machine) throw new ConflictError("Choose a treatment.");

  const client = await db.client.findUnique({ where: { id: input.clientId }, select: { id: true } });
  if (!client) throw new NotFoundError("Client not found");

  // F4: the per-session price comes from the admin-managed catalog, never the
  // request — the same rule the consultation path follows.
  const service = await db.servicePrice.findFirst({
    where: { kind: "treatment", key: machine, active: true },
    select: { price: true, cost: true, currency: true },
  });
  if (!service) throw new ConflictError(`No active catalog price for treatment "${machine}".`);

  const usdToLbp = await getUsdToLbp();

  const sell = async () =>
    db.$transaction(async (tx) => {
      const existing = await tx.sessionPlan.findFirst({
        where: { clientId: input.clientId, machine, status: "active" },
      });
      const plan = existing
        ? await tx.sessionPlan.update({
            where: { id: existing.id },
            // A top-up ADDS to the course; it never redefines it.
            data: { sessionsNeeded: existing.sessionsNeeded + sessions },
          })
        : await tx.sessionPlan.create({
            data: {
              clientId: input.clientId,
              machine,
              activeMachineKey: activeMachineKey("active", machine),
              unitPrice: service.price,
              // F-03: frozen per-session cost, same rule as createSessionPlan.
              unitCost: service.cost,
              currency: asCurrency(service.currency),
              usdToLbp,
              sessionsNeeded: sessions,
            },
          });

      const basket = await tx.visitBasket.create({
        data: {
          clientId: input.clientId,
          // No dietitian: a front-desk sale belongs to no visit and no doctor.
          // Stamping the seller here would show the secretary's name in the
          // "doctor" slot on the basket card, and would hide the basket from the
          // queue's doctor-scoped view for the wrong reason.
          dietitianId: null,
          status: "pending",
          currency: "USD",
          usdToLbp,
          items: {
            create: [
              {
                kind: "treatment",
                label: machine,
                detail: `${sessions} session${sessions === 1 ? "" : "s"} purchased`,
                quantity: sessions,
                // The plan's OWN frozen unit price, so a top-up costs exactly what
                // the same session costs through a consultation.
                unitPrice: plan.unitPrice,
                // F-03: same rule as the consultation path (consultations.ts) — a
                // plan-backed line inherits the cost frozen on the PLAN, never
                // today's catalog. Without this the line's `unitCost` silently
                // defaulted to 0, so every standalone session sale recognized $0
                // COGS and overstated gross/net profit in the profitability report.
                unitCost: plan.unitCost,
                currency: asCurrency(plan.currency),
                covered: false,
                sessionPlanId: plan.id,
              },
            ],
          },
        },
        select: { id: true },
      });

      await writeAudit(tx, {
        userId: actor?.id ?? null,
        userName: actor?.name,
        action: "Sold sessions",
        entityType: "SessionPlan",
        entityLabel: `${machine} ×${sessions} — ${auditMoney(plan.unitPrice * sessions, plan.currency)}`,
      });

      return { planId: plan.id, basketId: basket.id };
    });

  // Two sales racing to open the FIRST plan for a machine: the unique index on
  // (clientId, activeMachineKey) settles it. The loser retries, finds the winner's
  // plan and tops that up — the patient must never end up with two plans, and a
  // real sale must never be lost to a 500.
  const result = await sell().catch(async (e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return sell();
    throw e;
  });

  const plan = await getSessionPlan(result.planId);
  if (!plan) throw new NotFoundError("Treatment plan not found");
  return { plan, basketId: result.basketId };
}
