import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { auditMoney, writeAudit } from "./audit";
import { createPayment } from "./payments";
import { getUsdToLbp } from "./settings";
import type { ClientDebt } from "@/lib/types";

const include = {
  consultation: { select: { visitNumber: true } },
  client: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ClientDebtInclude;

type ClientDebtRow = Prisma.ClientDebtGetPayload<{ include: typeof include }>;

export function toClientDebt(d: ClientDebtRow): ClientDebt {
  return {
    id: d.id,
    clientId: d.clientId,
    clientName: `${d.client.firstName} ${d.client.lastName}`,
    consultationId: d.consultationId ?? undefined,
    visitNumber: d.consultation?.visitNumber ?? undefined,
    amount: d.amount,
    currency: asCurrency(d.currency),
    usdToLbp: d.usdToLbp,
    reason: d.reason,
    source: d.source as ClientDebt["source"],
    status: d.status as ClientDebt["status"],
    createdByName: d.createdByName ?? undefined,
    clearedByName: d.clearedByName ?? undefined,
    clearedAt: d.clearedAt?.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

export async function listClientDebts(clientId: string): Promise<ClientDebt[]> {
  const rows = await db.clientDebt.findMany({
    where: { clientId },
    include,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toClientDebt);
}

/** Every still-outstanding debt across all clients (for money-owed summaries). */
export async function listOutstandingDebts(): Promise<ClientDebt[]> {
  const rows = await db.clientDebt.findMany({
    where: { status: "outstanding" },
    include,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toClientDebt);
}

export type CreateClientDebtInput = {
  clientId: string;
  consultationId?: string | null;
  amount: number;
  currency?: string;
  usdToLbp?: number;
  reason: string;
  source?: string;
  createdByName?: string | null;
};

/**
 * Records a new outstanding debt inside the caller's transaction. Used by the
 * secretary override at settlement (source `secretary_override`) to defer the
 * unpaid/partial remainder of a basket. Skips creating a zero/negative row.
 * Returns the debt id, or null when there was nothing to record.
 */
export async function createClientDebtTx(
  tx: Prisma.TransactionClient,
  input: CreateClientDebtInput,
): Promise<string | null> {
  const amount = Math.max(0, input.amount);
  if (amount <= 0) return null;
  const created = await tx.clientDebt.create({
    data: {
      clientId: input.clientId,
      consultationId: input.consultationId ?? null,
      amount,
      currency: input.currency ?? "USD",
      // Freeze the rate so a mixed-currency debt total never re-prices later.
      usdToLbp: input.usdToLbp ?? (await getUsdToLbp()),
      reason: input.reason,
      source: input.source ?? "secretary_override",
      status: "outstanding",
      createdByName: input.createdByName ?? null,
    },
  });
  return created.id;
}

async function getClientDebtOrThrow(id: string): Promise<ClientDebt> {
  const row = await db.clientDebt.findUnique({ where: { id }, include });
  if (!row) throw new NotFoundError("Debt not found");
  return toClientDebt(row);
}

/**
 * Collects an outstanding debt now: records a real Payment for the amount (so the
 * income lands in reports and the receipt sequence) and marks the debt cleared —
 * both in one transaction, so they can't drift. A voided or already-cleared debt
 * can't be cleared again.
 */
export async function clearClientDebt(
  id: string,
  input: { method: string; notes?: string; clearedByName?: string | null; createdById?: string | null },
): Promise<ClientDebt> {
  await db.$transaction((tx) => clearClientDebtTx(tx, id, input));
  return getClientDebtOrThrow(id);
}

/**
 * The guarded-clear core, run on the caller's transaction so it can be reused
 * atomically — both by the standalone debt-clear route (via clearClientDebt) and
 * by basket settlement, which collects a client's old debt(s) alongside today's
 * charges in one transaction. Records the settlement Payment and a "Debt cleared"
 * audit entry, and flips the debt guarded on it still being outstanding so the
 * same debt can never be collected twice. Pass `expectedClientId` to reject a
 * debt that doesn't belong to the client being settled.
 */
export async function clearClientDebtTx(
  tx: Prisma.TransactionClient,
  id: string,
  input: {
    method: string;
    notes?: string;
    clearedByName?: string | null;
    createdById?: string | null;
    expectedClientId?: string;
  },
): Promise<void> {
  const debt = await tx.clientDebt.findUnique({ where: { id } });
  if (!debt) throw new NotFoundError("Debt not found");
  if (input.expectedClientId && debt.clientId !== input.expectedClientId) {
    throw new ConflictError("This debt does not belong to this client.");
  }
  if (debt.status !== "outstanding") {
    throw new ConflictError("This debt has already been settled or voided.");
  }
  // Flip the status FIRST, guarded on it still being outstanding. If a concurrent
  // clear already settled it this matches zero rows and we throw — rolling back
  // the payment created below — so the same debt can never be collected twice.
  // Mirrors the settle-basket guard rather than the earlier check-then-update.
  const cleared = await tx.clientDebt.updateMany({
    where: { id, status: "outstanding" },
    data: {
      status: "cleared",
      clearedAt: new Date(),
      clearedByName: input.clearedByName ?? null,
    },
  });
  if (cleared.count === 0) {
    throw new ConflictError("This debt has already been settled or voided.");
  }
  const payment = await createPayment(
    {
      clientId: debt.clientId,
      motif: `Debt settlement — ${debt.reason}`,
      amountPaid: debt.amount,
      currency: debt.currency,
      method: input.method,
      notes: input.notes,
      createdById: input.createdById ?? null,
      actorName: input.clearedByName,
      // A debt clear logs its own "Debt cleared" event below, so suppress the
      // generic "Recorded payment" row — one clearly-labeled entry per clear.
      skipAudit: true,
    },
    tx,
  );
  // Distinct, filterable debt-lifecycle event (mirrors the "Voided debt" entry),
  // referencing the settlement receipt so the money is still traceable.
  await writeAudit(tx, {
    userId: input.createdById ?? null,
    userName: input.clearedByName,
    action: "Debt cleared",
    entityType: "ClientDebt",
    entityLabel: `${auditMoney(debt.amount, debt.currency)} collected — ${payment.receiptNumber} — ${debt.reason}`,
  });
}

/**
 * Writes off an outstanding debt (forgiven — records no payment). A reason is
 * mandatory: writing off money is an accountability event, so who did it and why
 * is captured in the audit log (committed in the same transaction as the void).
 */
export async function voidClientDebt(
  id: string,
  input: { reason: string; clearedByName?: string | null; userId?: string | null },
): Promise<ClientDebt> {
  const reason = input.reason?.trim();
  if (!reason) throw new ConflictError("A reason is required to void a debt.");
  await db.$transaction(async (tx) => {
    const debt = await tx.clientDebt.findUnique({ where: { id } });
    if (!debt) throw new NotFoundError("Debt not found");
    if (debt.status !== "outstanding") {
      throw new ConflictError("This debt has already been settled or voided.");
    }
    // Flip guarded on the debt still being outstanding — the same conditional
    // updateMany used by clearClientDebtTx. Two concurrent voids can't both match,
    // so only one succeeds and writes a "Voided debt" row; the loser matches zero
    // rows and throws, rolling back its audit entry.
    const voided = await tx.clientDebt.updateMany({
      where: { id, status: "outstanding" },
      data: {
        status: "voided",
        clearedAt: new Date(),
        clearedByName: input.clearedByName ?? null,
      },
    });
    if (voided.count === 0) {
      throw new ConflictError("This debt has already been settled or voided.");
    }
    await writeAudit(tx, {
      userId: input.userId ?? null,
      userName: input.clearedByName,
      action: "Voided debt",
      entityType: "ClientDebt",
      entityLabel: `${auditMoney(debt.amount, debt.currency)} written off — ${reason}`,
    });
  });
  return getClientDebtOrThrow(id);
}
