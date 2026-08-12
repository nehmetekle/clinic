import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError } from "../http";
import { auditMoney, writeAudit } from "./audit";
import type {
  JessyReceivable,
  JessyReport,
  JessySettlement,
  JessySummary,
} from "@/lib/types";

/**
 * Jessy is a third-party/prepaid payer. When a patient settles through Jessy the
 * clinic recognizes the income IMMEDIATELY — a normal Payment row with method
 * "jessy", counted in every payment-method breakdown — and simultaneously records
 * that Jessy owes the clinic that amount (a JessyReceivable, written in the same
 * statement as the payment; see repositories/payments.ts).
 *
 * The three figures this module exposes must never be conflated:
 *   recorded    — what patients paid through Jessy (already income)
 *   settled     — what Jessy has actually transferred to the clinic
 *   outstanding — recorded − settled, what Jessy still owes
 *
 * A settlement therefore creates NO Payment and NO income: it only draws down
 * receivables. Recognizing it again would double-count money already reported.
 */

/** Money is stored to the cent; every arithmetic result is re-rounded to avoid
 * float drift accumulating across a FIFO allocation. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Half-cent tolerance for comparing rounded money, matching the settle-basket
// split check. Anything inside this is "equal", not a real over/under-payment.
const EPSILON = 0.005;

const receivableInclude = {
  payment: { select: { receiptNumber: true } },
  client: { select: { firstName: true, lastName: true } },
  consultation: { select: { visitNumber: true } },
} satisfies Prisma.JessyReceivableInclude;

type ReceivableRow = Prisma.JessyReceivableGetPayload<{ include: typeof receivableInclude }>;

function toJessyReceivable(r: ReceivableRow): JessyReceivable {
  return {
    id: r.id,
    paymentId: r.paymentId,
    receiptNumber: r.payment.receiptNumber,
    clientId: r.clientId ?? undefined,
    clientName: r.client ? `${r.client.firstName} ${r.client.lastName}` : undefined,
    consultationId: r.consultationId ?? undefined,
    visitNumber: r.consultation?.visitNumber ?? undefined,
    amount: r.amount,
    remaining: r.remaining,
    status: r.status as JessyReceivable["status"],
    createdByName: r.createdByName ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

const settlementInclude = {
  allocations: {
    orderBy: { createdAt: "asc" },
    include: {
      receivable: {
        include: {
          payment: { select: { receiptNumber: true } },
          client: { select: { firstName: true, lastName: true } },
        },
      },
    },
  },
} satisfies Prisma.JessySettlementInclude;

type SettlementRow = Prisma.JessySettlementGetPayload<{ include: typeof settlementInclude }>;

function toJessySettlement(s: SettlementRow): JessySettlement {
  return {
    id: s.id,
    amount: s.amount,
    reference: s.reference ?? undefined,
    notes: s.notes ?? undefined,
    recordedByName: s.recordedByName ?? undefined,
    createdAt: s.createdAt.toISOString(),
    allocations: s.allocations.map((a) => ({
      receivableId: a.receivableId,
      receiptNumber: a.receivable.payment.receiptNumber,
      clientName: a.receivable.client
        ? `${a.receivable.client.firstName} ${a.receivable.client.lastName}`
        : undefined,
      amount: a.amount,
    })),
  };
}

/**
 * What Jessy still owes the clinic, in USD. A snapshot, never windowed by a
 * reporting period: it is a balance, not a flow. Summed from `remaining` (the
 * authoritative per-receivable figure) rather than recomputed from settlements,
 * so it can't drift from what the allocator actually wrote.
 */
export async function getJessyOutstanding(
  client: Prisma.TransactionClient = db,
): Promise<number> {
  const agg = await client.jessyReceivable.aggregate({ _sum: { remaining: true } });
  return round2(agg._sum.remaining ?? 0);
}

export async function getJessySummary(
  client: Prisma.TransactionClient = db,
): Promise<JessySummary> {
  const [receivables, settlements] = await Promise.all([
    client.jessyReceivable.aggregate({ _sum: { amount: true, remaining: true } }),
    client.jessySettlement.aggregate({ _sum: { amount: true } }),
  ]);
  return {
    recorded: round2(receivables._sum.amount ?? 0),
    settled: round2(settlements._sum.amount ?? 0),
    outstanding: round2(receivables._sum.remaining ?? 0),
  };
}

/** The full Jessy ledger for the admin page: the three headline figures, every
 * receivable (newest first) and the settlement history with its allocations. */
export async function getJessyReport(): Promise<JessyReport> {
  const [summary, receivables, settlements] = await Promise.all([
    getJessySummary(),
    db.jessyReceivable.findMany({ include: receivableInclude, orderBy: { createdAt: "desc" } }),
    db.jessySettlement.findMany({ include: settlementInclude, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    summary,
    receivables: receivables.map(toJessyReceivable),
    settlements: settlements.map(toJessySettlement),
  };
}

export type RecordJessySettlementInput = {
  amount: number;
  reference?: string;
  notes?: string;
  recordedById?: string | null;
  recordedByName?: string | null;
  // Client-supplied key so a double-click can't record the same transfer twice.
  idempotencyKey?: string | null;
};

/**
 * Records money actually received from Jessy and applies it to the outstanding
 * receivables OLDEST FIRST (FIFO), so the oldest debt Jessy owes clears first.
 *
 * Creates no Payment and no income — that was already recognized when each
 * patient paid through Jessy. Recording it again would double-count it.
 *
 * Safety under concurrency, all inside one transaction:
 *  - each draw-down is a conditional `updateMany` guarded on
 *    `remaining >= portion`, so the WHERE and the decrement are evaluated in a
 *    single atomic UPDATE. Two simultaneous settlements racing the same balance
 *    serialize on the row lock; the loser re-evaluates the guard, matches zero
 *    rows, and throws — it can never drive `remaining` negative.
 *  - the DB additionally carries a CHECK (remaining BETWEEN 0 AND amount), so
 *    even a bug here aborts the transaction instead of corrupting the balance.
 *  - over-settlement is rejected up front against the live outstanding total.
 */
export async function recordJessySettlement(
  input: RecordJessySettlementInput,
): Promise<JessySummary> {
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new ConflictError("The settlement amount must be greater than 0.");

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const existing = await db.jessySettlement.findUnique({ where: { idempotencyKey } });
    // A repeated key is the same transfer being submitted twice — return the
    // current balance rather than drawing the receivables down a second time.
    if (existing) return getJessySummary();
  }

  await db.$transaction(async (tx) => {
    // Oldest first: FIFO is what makes a partial settlement predictable and lets
    // the allocation history read as "Jessy paid off these visits".
    const open = await tx.jessyReceivable.findMany({
      where: { status: "outstanding", remaining: { gt: 0 } },
      orderBy: { createdAt: "asc" },
      select: { id: true, remaining: true },
    });
    const outstanding = round2(open.reduce((s, r) => s + r.remaining, 0));

    if (outstanding <= 0) {
      throw new ConflictError("Jessy has no outstanding balance to settle.");
    }
    // Over-settlement is refused outright rather than clamped, so a typo can't
    // silently invent a credit the clinic is not owed.
    if (amount - outstanding > EPSILON) {
      throw new ConflictError(
        `Jessy only owes ${outstanding.toFixed(2)} — you can't settle ${amount.toFixed(2)}.`,
      );
    }

    const settlement = await tx.jessySettlement.create({
      data: {
        amount,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        idempotencyKey,
        recordedById: input.recordedById ?? null,
        recordedByName: input.recordedByName ?? null,
      },
    });

    let left = amount;
    const drained: string[] = [];
    for (const r of open) {
      if (left <= EPSILON) break;
      const portion = round2(Math.min(left, r.remaining));
      if (portion <= 0) continue;

      // Atomic guarded draw-down (see the note above). `count === 0` means a
      // concurrent settlement took this balance first.
      const applied = await tx.jessyReceivable.updateMany({
        where: { id: r.id, remaining: { gte: portion } },
        data: { remaining: { decrement: portion } },
      });
      if (applied.count === 0) {
        throw new ConflictError(
          "Another Jessy settlement was recorded at the same time. Reload the page and re-enter the amount.",
        );
      }

      await tx.jessySettlementAllocation.create({
        data: { settlementId: settlement.id, receivableId: r.id, amount: portion },
      });
      drained.push(r.id);
      left = round2(left - portion);
    }

    // The up-front check guarantees enough balance existed; if anything is left
    // over, a concurrent settlement consumed it mid-loop. Roll the whole thing
    // back rather than record a transfer that was only partly applied.
    if (left > EPSILON) {
      throw new ConflictError(
        "Another Jessy settlement was recorded at the same time. Reload the page and re-enter the amount.",
      );
    }

    // Close out every receivable this transfer fully paid off. Guarded on the
    // balance actually reaching zero, so a part-paid one stays outstanding.
    await tx.jessyReceivable.updateMany({
      where: { id: { in: drained }, remaining: { lte: EPSILON } },
      data: { status: "settled" },
    });

    await writeAudit(tx, {
      userId: input.recordedById ?? null,
      userName: input.recordedByName,
      action: "Jessy settlement recorded",
      entityType: "JessySettlement",
      entityLabel: `${auditMoney(amount, "USD")} received from Jessy across ${drained.length} receivable(s)${
        input.reference?.trim() ? ` — ref ${input.reference.trim()}` : ""
      }`,
    });
  });

  return getJessySummary();
}
