import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError } from "../http";
import { auditMoney, writeAudit } from "./audit";

/**
 * Referral commissions — what the clinic owes the people who send it patients.
 *
 * The rule this module exists to enforce:
 *
 *   Registering a patient commits the clinic to NOTHING. The commission is
 *   incurred when that patient's FIRST VISIT COMPLETES, priced at the referrer's
 *   rate at that moment, and frozen there. Paying it later moves cash and
 *   recognizes no second expense.
 *
 * Three figures that must never be conflated (the same discipline the Jessy
 * ledger keeps, for the same reason — this is its mirror image, money owed OUT
 * rather than money owed IN):
 *
 *   incurred     — what the clinic became liable for (an EXPENSE, once, dated
 *                  `incurredAt`)
 *   paid         — what has actually been transferred to referrers (CASH OUT,
 *                  dated by its payout; never an expense)
 *   outstanding  — incurred − paid − voided, a BALANCE, never windowed
 */

/** Visit kinds that count as "the patient attended". */
export type ReferralTrigger =
  | { type: "consultation"; consultationId: string }
  | { type: "machine_visit"; machineVisitId: string };

/**
 * Records the commission for a patient's FIRST completed visit, if one is owed.
 * Runs inside the caller's transaction so the commission commits with the visit
 * that triggered it — a visit that closes without its commission, or a commission
 * for a close that rolled back, would both be wrong.
 *
 * Returns silently in every "nothing to owe" case, because this is called from
 * the close path and must never be able to fail a visit:
 *
 *  - the patient has no referrer attributed (walked in, or "None"),
 *  - the referrer row is gone (deleted since registration),
 *  - the referrer's rate is 0 today,
 *  - a commission already exists for this patient (this is not their first visit,
 *    or two visits completed at the same instant and the other one won).
 *
 * THE AMOUNT IS READ NOW, NOT AT REGISTRATION. That is the whole point of moving
 * the trigger: the rate that applies is the one in force when the obligation is
 * created. A later edit to the referrer's fee prices future referrals only —
 * `amount` here is frozen and nothing rewrites it.
 */
export async function recordReferralCommissionTx(
  tx: Prisma.TransactionClient,
  clientId: string,
  trigger: ReferralTrigger,
  actorName?: string | null,
): Promise<void> {
  // Cheap exit first: the overwhelmingly common call is a returning patient, who
  // already has a row (or has no referrer at all).
  const existing = await tx.referralCommission.findUnique({
    where: { clientId },
    select: { id: true },
  });
  if (existing) return;

  // Same row lock `updateClient` takes when it re-targets attribution before a
  // commission exists: without it, a referrer reassignment racing this close
  // could win the read here a moment before the reassignment commits, and this
  // visit would incur against a referrer that's about to be replaced.
  await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id" = ${clientId} FOR UPDATE`;

  const client = await tx.client.findUnique({
    where: { id: clientId },
    select: { referrerId: true, referrerNameSnapshot: true, firstName: true, lastName: true },
  });
  // No attribution set => nobody to pay. Note this reads `referrerId`, the
  // identity that (until this moment) still tracks `referralSource` edits, not
  // the free-text field itself — and after this call returns, `updateClient`
  // will see the row this created and stop moving it.
  if (!client?.referrerId || !client.referrerNameSnapshot) return;

  const referrer = await tx.referrer.findUnique({
    where: { id: client.referrerId },
    select: { fee: true },
  });
  // Deleted referrer, or a rate of zero: no obligation exists, so no row is
  // written. The CHECK constraint (`amount > 0`) enforces the same rule at the
  // database, so a zero-value entry can never enter the ledger by another route.
  const amount = referrer?.fee ?? 0;
  if (!(amount > 0)) return;

  try {
    await tx.referralCommission.create({
      data: {
        clientId,
        referrerId: client.referrerId,
        // Frozen name, not a join: this row stays attributable after the referrer
        // is renamed or deleted.
        referrerNameSnapshot: client.referrerNameSnapshot,
        amount,
        triggerType: trigger.type,
        triggerConsultationId:
          trigger.type === "consultation" ? trigger.consultationId : null,
        triggerMachineVisitId:
          trigger.type === "machine_visit" ? trigger.machineVisitId : null,
      },
    });
  } catch (e) {
    // Two visits completing together both passed the read above; the unique index
    // settles it. The loser treats the winner's row as the answer — a patient's
    // first visit happened once, however many requests observed it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return;
    throw e;
  }

  await writeAudit(tx, {
    userName: actorName,
    action: "Referral commission incurred",
    entityType: "ReferralCommission",
    entityLabel:
      `${auditMoney(amount, "USD")} owed to ${client.referrerNameSnapshot} — ` +
      `${client.firstName} ${client.lastName}'s first completed visit`,
  });
}

/** Every commission still owed, oldest first — the payout screen's worklist. */
export async function listOutstandingCommissions(referrerId?: string) {
  return db.referralCommission.findMany({
    where: { status: "incurred", ...(referrerId ? { referrerId } : {}) },
    include: { client: { select: { firstName: true, lastName: true } } },
    orderBy: { incurredAt: "asc" },
  });
}

/**
 * The three headline figures. `outstanding` is a BALANCE and is deliberately not
 * windowed — the same rule as "Outstanding from Jessy". `incurred` is the only
 * one that belongs in a period P&L.
 */
export async function getReferralSummary(range?: { from?: Date; to?: Date }): Promise<{
  incurred: number;
  paid: number;
  outstanding: number;
}> {
  const window =
    range?.from || range?.to
      ? { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) }
      : undefined;
  const [incurred, paid, outstanding] = await Promise.all([
    db.referralCommission.aggregate({
      _sum: { amount: true },
      where: { status: { not: "void" }, ...(window ? { incurredAt: window } : {}) },
    }),
    db.referralPayout.aggregate({
      _sum: { amount: true },
      where: window ? { paidAt: window } : undefined,
    }),
    // Never windowed: a balance is what is owed right now, not what was owed
    // during some period.
    db.referralCommission.aggregate({
      _sum: { amount: true },
      where: { status: "incurred" },
    }),
  ]);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    incurred: round2(incurred._sum.amount ?? 0),
    paid: round2(paid._sum.amount ?? 0),
    outstanding: round2(outstanding._sum.amount ?? 0),
  };
}

/**
 * Records money actually paid to a referrer against specific incurred
 * commissions.
 *
 * Creates NO Expense and NO Payment. The expense was recognized when each
 * commission was incurred; recognizing it again here would double-count it, and
 * `Payment` in this app means money coming IN. This is a cash movement only.
 *
 * Concurrency: each commission is flipped by a conditional `updateMany` guarded
 * on it still being `incurred`, so two payouts racing the same commission cannot
 * both claim it — the loser matches zero rows and the whole payout rolls back
 * rather than paying half of it twice.
 */
export async function recordReferralPayout(input: {
  commissionIds: string[];
  reference?: string;
  notes?: string;
  recordedById?: string | null;
  recordedByName?: string | null;
  idempotencyKey?: string | null;
}): Promise<{ id: string; amount: number; count: number }> {
  const ids = [...new Set(input.commissionIds)];
  if (ids.length === 0) throw new ConflictError("Select at least one commission to pay.");

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const replay = await db.referralPayout.findUnique({ where: { idempotencyKey } });
    // The same transfer submitted twice is one transfer.
    if (replay) return { id: replay.id, amount: replay.amount, count: ids.length };
  }

  return db.$transaction(async (tx) => {
    const commissions = await tx.referralCommission.findMany({
      where: { id: { in: ids } },
      select: { id: true, amount: true, status: true, referrerId: true, referrerNameSnapshot: true },
    });
    if (commissions.length !== ids.length) {
      throw new ConflictError("One of those commissions no longer exists.");
    }
    const notPayable = commissions.find((c) => c.status !== "incurred");
    if (notPayable) {
      throw new ConflictError("One of those commissions has already been paid or voided.");
    }
    // A payout is to ONE referrer: mixing them would make the payout's own
    // reference (a cheque number, a transfer id) meaningless.
    const referrerNames = new Set(commissions.map((c) => c.referrerNameSnapshot));
    if (referrerNames.size !== 1) {
      throw new ConflictError("A payout covers one referrer at a time.");
    }

    const amount = Math.round(commissions.reduce((s, c) => s + c.amount, 0) * 100) / 100;
    const payout = await tx.referralPayout.create({
      data: {
        referrerId: commissions[0].referrerId,
        referrerNameSnapshot: commissions[0].referrerNameSnapshot,
        amount,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        idempotencyKey,
        recordedById: input.recordedById ?? null,
        recordedByName: input.recordedByName ?? null,
      },
    });

    // Guarded flip: only commissions STILL outstanding are claimed. If a
    // concurrent payout took one, this count falls short and we abort, rolling
    // back the payout row above — the same money is never paid twice.
    const claimed = await tx.referralCommission.updateMany({
      where: { id: { in: ids }, status: "incurred" },
      data: { status: "paid", paidAt: payout.paidAt, payoutId: payout.id },
    });
    if (claimed.count !== ids.length) {
      throw new ConflictError("One of those commissions was just paid by someone else.");
    }

    await writeAudit(tx, {
      userId: input.recordedById ?? null,
      userName: input.recordedByName,
      action: "Referral commission paid",
      entityType: "ReferralPayout",
      entityLabel:
        `${auditMoney(amount, "USD")} paid to ${commissions[0].referrerNameSnapshot} — ` +
        `${ids.length} commission${ids.length === 1 ? "" : "s"}` +
        `${input.reference?.trim() ? ` — ref ${input.reference.trim()}` : ""}`,
    });

    return { id: payout.id, amount, count: ids.length };
  });
}

/**
 * Writes off a commission the clinic will not pay. Mirrors `voidClientDebt`: a
 * reason is mandatory, because forgiving an obligation is an accountability
 * event. The row stays in the ledger — voiding is not deleting.
 */
export async function voidReferralCommission(
  id: string,
  input: { reason: string; actorName?: string | null; userId?: string | null },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) throw new ConflictError("A reason is required to void a commission.");
  await db.$transaction(async (tx) => {
    const row = await tx.referralCommission.findUnique({ where: { id } });
    if (!row) throw new ConflictError("Commission not found.");
    if (row.status === "paid") {
      throw new ConflictError("This commission has already been paid and can't be voided.");
    }
    const voided = await tx.referralCommission.updateMany({
      where: { id, status: "incurred" },
      data: { status: "void", voidReason: reason, voidedByName: input.actorName ?? null },
    });
    if (voided.count === 0) throw new ConflictError("This commission is already settled or voided.");
    await writeAudit(tx, {
      userId: input.userId ?? null,
      userName: input.actorName,
      action: "Referral commission voided",
      entityType: "ReferralCommission",
      entityLabel: `${auditMoney(row.amount, "USD")} to ${row.referrerNameSnapshot} written off — ${reason}`,
    });
  });
}

/**
 * The full referral ledger for the admin page: the three headline figures, every
 * commission (newest first) and the payout history. Mirrors `getJessyReport` —
 * the same shape of problem gets the same shape of answer.
 */
export async function getReferralReport(): Promise<{
  summary: { incurred: number; paid: number; outstanding: number };
  commissions: {
    id: string;
    clientId: string;
    clientName: string;
    referrerName: string;
    amount: number;
    incurredAt: string;
    triggerType: string;
    status: string;
    paidAt?: string;
    voidReason?: string;
  }[];
  payouts: {
    id: string;
    referrerName: string;
    amount: number;
    reference?: string;
    notes?: string;
    paidAt: string;
    recordedByName?: string;
    commissionCount: number;
    clients: { clientId: string; clientName: string; amount: number }[];
  }[];
}> {
  const [summary, commissions, payouts] = await Promise.all([
    getReferralSummary(),
    db.referralCommission.findMany({
      include: { client: { select: { firstName: true, lastName: true } } },
      orderBy: { incurredAt: "desc" },
    }),
    db.referralPayout.findMany({
      include: {
        commissions: {
          include: { client: { select: { firstName: true, lastName: true } } },
        },
      },
      orderBy: { paidAt: "desc" },
    }),
  ]);
  return {
    summary,
    commissions: commissions.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      clientName: `${c.client.firstName} ${c.client.lastName}`,
      referrerName: c.referrerNameSnapshot,
      amount: c.amount,
      incurredAt: c.incurredAt.toISOString(),
      triggerType: c.triggerType,
      status: c.status,
      paidAt: c.paidAt?.toISOString(),
      voidReason: c.voidReason ?? undefined,
    })),
    payouts: payouts.map((p) => ({
      id: p.id,
      referrerName: p.referrerNameSnapshot,
      amount: p.amount,
      reference: p.reference ?? undefined,
      notes: p.notes ?? undefined,
      paidAt: p.paidAt.toISOString(),
      recordedByName: p.recordedByName ?? undefined,
      commissionCount: p.commissions.length,
      clients: p.commissions.map((c) => ({
        clientId: c.clientId,
        clientName: `${c.client.firstName} ${c.client.lastName}`,
        amount: c.amount,
      })),
    })),
  };
}
