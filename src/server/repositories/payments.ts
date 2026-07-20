import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency, asPaymentMethod, dateOnly } from "../serialize";
import { clinicDayRange, todayIso } from "@/lib/config";
import { auditMoney, writeAudit } from "./audit";
import { nextCounterValue } from "./counters";
import { getUsdToLbp } from "./settings";
import type { Payment } from "@/lib/types";

export const paymentInclude = {
  client: true,
  createdBy: { select: { fullName: true } },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

export function toPayment(p: PaymentRow): Payment {
  return {
    id: p.id,
    clientId: p.clientId ?? undefined,
    clientName: p.client ? `${p.client.firstName} ${p.client.lastName}` : undefined,
    createdByName: p.createdBy?.fullName ?? undefined,
    motif: p.motif,
    amountPaid: p.amountPaid,
    currency: asCurrency(p.currency),
    usdToLbp: p.usdToLbp,
    method: asPaymentMethod(p.method),
    date: dateOnly(p.date)!,
    receiptNumber: p.receiptNumber,
    notes: p.notes ?? undefined,
  };
}

/**
 * Lists payments, newest first. Pass a clinic-day (`YYYY-MM-DD`) to return only
 * that day's receipts — the range is timezone-correct (see clinicDayRange), so a
 * payment logged just after clinic-midnight lands on the right day. Omit `date`
 * to return every payment (used by the global receipt search).
 */
export async function listPayments(date?: string): Promise<Payment[]> {
  const rows = await db.payment.findMany({
    where: date ? { date: clinicDayRange(date) } : undefined,
    include: paymentInclude,
    orderBy: { date: "desc" },
  });
  return rows.map(toPayment);
}

/**
 * Generates the next receipt number from a monotonic DB counter (not a row
 * count), so two concurrent payments can never produce the same number and a
 * deleted payment never frees its number for reuse. Pass the surrounding
 * transaction client so the number is reserved atomically with the payment.
 */
export async function nextReceiptNumber(
  client: Prisma.TransactionClient = db,
): Promise<string> {
  // Clinic-year, so a receipt logged around New Year is numbered by the clinic's
  // calendar, not the server host's timezone.
  const year = todayIso().slice(0, 4);
  const seq = await nextCounterValue("receipt", client);
  return `RCP-${year}-${String(seq).padStart(6, "0")}`;
}

export async function createPayment(
  input: {
    clientId?: string | null;
    motif: string;
    amountPaid: number;
    currency?: string;
    method: string;
    notes?: string;
    // Who collected/recorded the money (the acting user, resolved to a User row
    // by the route) — so every payment is traceable to a person.
    createdById?: string | null;
    // Display name of the acting user, for the audit-log entry written below.
    actorName?: string | null;
    // R2: client-supplied idempotency key for MANUAL payments. If a payment with
    // this key already exists (double-click / retry / back-button resubmit), the
    // existing one is returned instead of creating a duplicate. Null/omitted for
    // internal callers (basket settlement, debt clear), which are guarded by their
    // own transaction status-flip and legitimately create similar payments.
    idempotencyKey?: string | null;
    // Suppress the generic "Recorded payment" audit entry when the caller logs a
    // more specific event for the same money (e.g. a debt clear logs "Debt
    // cleared" instead). The Payment row itself is always created.
    skipAudit?: boolean;
  },
  // Runs on the shared client by default, or inside the caller's transaction
  // (e.g. basket settlement) so the payment and its receipt number commit — or
  // roll back — as one atomic unit.
  client: Prisma.TransactionClient = db,
): Promise<Payment> {
  // A payment can be tied to a patient or be a general clinic payment. Only
  // validate the client when one was supplied.
  if (input.clientId) {
    const clientRow = await client.client.findUnique({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!clientRow) throw new NotFoundError("Client not found");
  }

  const motif = input.motif.trim();
  if (!motif) throw new ConflictError("Motif is required");

  // R2: a repeated idempotency key returns the already-recorded payment rather
  // than creating a second income row (handles double-click / retry / resubmit).
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const existing = await client.payment.findUnique({
      where: { idempotencyKey },
      include: paymentInclude,
    });
    if (existing) return toPayment(existing);
  }

  // Negative amounts are rejected at the schema (R5); this is a non-negative value.
  const amountPaid = input.amountPaid;

  let row: PaymentRow;
  try {
    row = await client.payment.create({
      data: {
        clientId: input.clientId ?? null,
        motif,
        amountPaid,
        currency: input.currency ?? "USD",
        // Freeze the live exchange rate onto the record so reports never re-price it.
        usdToLbp: await getUsdToLbp(),
        method: input.method,
        date: new Date(),
        receiptNumber: await nextReceiptNumber(client),
        idempotencyKey,
        notes: input.notes?.trim() || null,
        createdById: input.createdById ?? null,
      },
      include: paymentInclude,
    });
  } catch (e) {
    // Concurrent double-submit: the other request won the unique key. Return its
    // payment so the duplicate click still succeeds idempotently (manual path only,
    // which runs outside a transaction, so this refetch is safe).
    if (
      idempotencyKey &&
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const existing = await client.payment.findUnique({
        where: { idempotencyKey },
        include: paymentInclude,
      });
      if (existing) return toPayment(existing);
    }
    throw e;
  }
  // Every collection is logged for accountability. Written on the same client as
  // the payment, so it commits (or rolls back) atomically with it — including when
  // createPayment runs inside a basket-settlement or debt-clear transaction.
  if (!input.skipAudit) await writeAudit(client, {
    userId: input.createdById ?? null,
    userName: input.actorName,
    action: "Recorded payment",
    entityType: "Payment",
    entityLabel: `${row.receiptNumber} — ${auditMoney(row.amountPaid, row.currency)} — ${motif}`,
  });
  return toPayment(row);
}
