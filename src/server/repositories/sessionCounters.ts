import { Prisma } from "@prisma/client";
import { ConflictError, NotFoundError } from "../http";
import { activeMachineKey } from "./sessionPlans";

/**
 * The one place session counters move.
 *
 * Both things that consume prepaid sessions — a consultation's treatment rows and
 * a machine visit — route through here, so there is a single set of invariants
 * rather than two implementations that drift.
 *
 * Every write is a GUARDED SQL statement: the new value is computed by the
 * database from the row's own current value, under the row lock, in one
 * statement. The read-then-write pattern this replaces could lose a consumption
 * when two desks saved at the same moment (both read "4 used", both wrote "5").
 * A guarded UPDATE that matches no row is the signal that the balance moved under
 * us — reported as a conflict, never silently clamped to a smaller number.
 */

/** Keeps active↔completed in step with usage; preserves other statuses. */
export function statusForUsage(current: string, used: number, total: number): string {
  if (used >= total) return "completed";
  if (current === "completed") return "active"; // reactivate when a reversal frees a session
  return current;
}

/**
 * Re-derives a plan's status (and the uniqueness key that mirrors it) from the
 * row as it stands AFTER a counter move. Safe to call inside the same transaction
 * as the move: that row is locked by us until commit, so nothing can slip in
 * between and make the status stale.
 */
async function syncSessionPlanStatusTx(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<void> {
  const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
  if (!plan) return;
  const status = statusForUsage(plan.status, plan.sessionsUsed, plan.sessionsNeeded);
  const key = activeMachineKey(status, plan.machine);
  if (status === plan.status && key === plan.activeMachineKey) return;
  await tx.sessionPlan.update({
    where: { id: planId },
    data: { status, activeMachineKey: key },
  });
}

async function syncClientPackageStatusTx(
  tx: Prisma.TransactionClient,
  packageId: string,
): Promise<void> {
  const cp = await tx.clientPackage.findUnique({ where: { id: packageId } });
  if (!cp) return;
  const status = statusForUsage(cp.status, cp.usedSessions, cp.totalSessions);
  if (status === cp.status) return;
  await tx.clientPackage.update({ where: { id: packageId }, data: { status } });
}

/**
 * Consumes `sessions` from a session plan, refusing when the plan cannot absorb
 * them. `ceiling: true` also caps consumption at what the plan says the patient
 * needs — the machine-visit rule, which keeps logging a visit from quietly
 * becoming a way to buy sessions nobody ordered. The consultation path passes
 * `ceiling: false`: its editor is where `sessionsNeeded` is set in the first
 * place, and it has always been allowed to record more delivered than ordered.
 */
export async function consumeSessionPlanTx(
  tx: Prisma.TransactionClient,
  input: { planId: string; clientId: string; sessions: number; ceiling: boolean },
): Promise<void> {
  const { planId, clientId, sessions } = input;
  if (sessions <= 0) return;

  const affected = input.ceiling
    ? await tx.$executeRaw`
        UPDATE "SessionPlan"
           SET "sessionsUsed" = "sessionsUsed" + ${sessions}, "updatedAt" = NOW()
         WHERE "id" = ${planId}
           AND "clientId" = ${clientId}
           AND "status" <> 'cancelled'
           AND "sessionsUsed" + ${sessions} <= "sessionsNeeded"`
    : await tx.$executeRaw`
        UPDATE "SessionPlan"
           SET "sessionsUsed" = "sessionsUsed" + ${sessions}, "updatedAt" = NOW()
         WHERE "id" = ${planId}
           AND "clientId" = ${clientId}
           AND "status" <> 'cancelled'`;

  if (affected === 0) {
    // Nothing matched: say which of the guards it was, reading the row now that
    // the contended write (if any) has committed.
    const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.clientId !== clientId) {
      throw new NotFoundError("Treatment plan not found for this patient.");
    }
    if (plan.status === "cancelled") throw new ConflictError("This treatment plan is cancelled.");
    const left = Math.max(0, plan.sessionsNeeded - plan.sessionsUsed);
    throw new ConflictError(
      `Only ${left} session${left === 1 ? "" : "s"} left on this plan.`,
    );
  }
  await syncSessionPlanStatusTx(tx, planId);
}

/**
 * Consumes `sessions` from a bundle, refusing when the balance is short. This is
 * where the old silent clamp lived: asking for 3 sessions against a bundle with 1
 * left used to record 1 and report success. It now records 3 or nothing.
 */
export async function consumeClientPackageTx(
  tx: Prisma.TransactionClient,
  input: { packageId: string; clientId: string; sessions: number },
): Promise<void> {
  const { packageId, clientId, sessions } = input;
  if (sessions <= 0) return;

  const affected = await tx.$executeRaw`
    UPDATE "ClientPackage"
       SET "usedSessions" = "usedSessions" + ${sessions}, "updatedAt" = NOW()
     WHERE "id" = ${packageId}
       AND "clientId" = ${clientId}
       AND "status" <> 'cancelled'
       AND "usedSessions" + ${sessions} <= "totalSessions"`;

  if (affected === 0) {
    const cp = await tx.clientPackage.findUnique({ where: { id: packageId } });
    if (!cp || cp.clientId !== clientId) {
      throw new NotFoundError("Bundle not found for this patient.");
    }
    if (cp.status === "cancelled") throw new ConflictError("This bundle is cancelled.");
    const left = Math.max(0, cp.totalSessions - cp.usedSessions);
    throw new ConflictError(
      `Only ${left} session${left === 1 ? "" : "s"} left on this bundle.`,
    );
  }
  await syncClientPackageStatusTx(tx, packageId);
}

/**
 * Gives sessions back (a consultation edit/delete, a voided machine visit).
 * Floored at zero in SQL so a double reversal can never drive a counter negative,
 * and never refused — releasing a hold must always be able to complete.
 */
export async function releaseSessionPlanTx(
  tx: Prisma.TransactionClient,
  planId: string,
  sessions: number,
): Promise<void> {
  if (sessions <= 0) return;
  await tx.$executeRaw`
    UPDATE "SessionPlan"
       SET "sessionsUsed" = GREATEST(0, "sessionsUsed" - ${sessions}), "updatedAt" = NOW()
     WHERE "id" = ${planId}`;
  await syncSessionPlanStatusTx(tx, planId);
}

export async function releaseClientPackageTx(
  tx: Prisma.TransactionClient,
  packageId: string,
  sessions: number,
): Promise<void> {
  if (sessions <= 0) return;
  await tx.$executeRaw`
    UPDATE "ClientPackage"
       SET "usedSessions" = GREATEST(0, "usedSessions" - ${sessions}), "updatedAt" = NOW()
     WHERE "id" = ${packageId}`;
  await syncClientPackageStatusTx(tx, packageId);
}

/**
 * Advances a plan's paid count at settlement — an atomic increment rather than a
 * read-then-write, so two baskets settling at once can't lose one side's payment.
 */
export async function creditSessionPlanPaidTx(
  tx: Prisma.TransactionClient,
  planId: string,
  sessions: number,
): Promise<void> {
  if (sessions <= 0) return;
  await tx.sessionPlan.update({
    where: { id: planId },
    data: { sessionsPaid: { increment: sessions } },
  });
}
