import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asPaymentMethod, asTenderCurrency, dateOnly } from "../serialize";
import { clinicDayRange, todayIso } from "@/lib/config";
import { cardSurchargeAmount, moneyCap } from "@/lib/utils";
import { JESSY_METHOD } from "@/lib/types";
import {
  fxRateFor,
  paymentUsd,
  tenderToUsd,
  type TenderCurrency,
} from "@/lib/money";
import { auditMoney, writeAudit } from "./audit";
import { nextCounterValue } from "./counters";
import { getSettings } from "./settings";
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
    currency: asTenderCurrency(p.currency),
    usdToLbp: p.usdToLbp,
    fxRate: p.fxRate ?? undefined,
    // Server-computed at ITS OWN frozen rate, so no client ever performs FX maths
    // on money and today's Settings can never re-price this row. Throws (never
    // guesses) if the row carries no usable frozen rate — see frozenPaymentFxRate.
    amountUsd: paymentUsd(p),
    cardSurchargeAmount: p.cardSurchargeAmount,
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
    // TENDER currency. The obligation being settled stays USD — see lib/money.ts.
    currency?: TenderCurrency;
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
    // Links this payment to the visit basket it settles (one portion of a split
    // settlement). Set by settleVisitBasket so all method portions of a settlement
    // are discoverable from the basket; null for standalone/manual payments.
    visitBasketId?: string | null;
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
  // Universal rule, enforced here (the single place every Payment row is written,
  // whatever the caller — manual entry, basket settlement, debt clear, …): card
  // method → the clinic's configured surcharge is added on top of `amountPaid`,
  // so it ends up as what the client actually pays. Frozen here, like `usdToLbp`,
  // so a later rate change never reprices history. Every other method is $0.
  //
  // The surcharge is calculated in the payment's OWN currency, not in USD. It is
  // a pure percentage, so `pct% of native / fxRate` and `pct% of (native/fxRate)`
  // are the same number — but computing it natively means ONE rounding instead of
  // two, and it preserves this table's existing invariant that
  // `cardSurchargeAmount` is a portion of `amountPaid` expressed in the same unit.
  const settings = await getSettings();
  const surcharge =
    input.method === "card"
      ? cardSurchargeAmount(input.amountPaid, input.method, settings.cardSurchargePercent)
      : 0;
  const amountPaid = Math.round((input.amountPaid + surcharge) * 100) / 100;
  // R5 applies to what's actually recorded, not just what was entered — a card
  // amount just under the cap can cross it once the surcharge is added, and the
  // schema-level check (on the pre-surcharge input) can't see that.
  if (amountPaid > moneyCap(input.currency)) {
    throw new ConflictError(
      `Amount is unreasonably large (max ${moneyCap(input.currency).toLocaleString()} ${input.currency ?? "USD"})${
        surcharge > 0 ? " once the card surcharge is included" : ""
      }.`,
    );
  }

  // Freeze the live exchange rate onto the record so reports never re-price it.
  // `usdToLbp` stays exactly what it always was (the LBP snapshot every existing
  // row and report reads); `fxRate` is this payment's OWN rate — the one that
  // values it — resolved server-side from admin-controlled Settings. A rate is
  // NEVER accepted from the caller: a client-supplied rate is an unaudited
  // discount channel, so there is deliberately no input field for one.
  const usdToLbp = settings.usdToLbp;
  const currency: TenderCurrency = input.currency ?? "USD";
  // Jessy's receivable ledger is USD-only (FIFO allocation across receivables is
  // only sound in one unit). Enforced HERE, at the single chokepoint every Payment
  // goes through, so no route, transaction or future caller can bypass it.
  if (input.method === JESSY_METHOD && currency !== "USD") {
    throw new ConflictError(
      "Jessy can only be recorded in USD — its receivable ledger is USD-only.",
    );
  }
  // Throws (409) on a missing/absurd/non-finite rate rather than guessing: a
  // payment that cannot be valued must not be recorded.
  const fxRate = fxRateFor(currency, settings);

  // Jessy (third-party payer): the money counts as income right now, exactly like
  // any other method — but Jessy itself still owes the clinic that amount, which
  // is tracked as a JessyReceivable. Built as a NESTED create below so the
  // payment and its receivable are written in one statement: a jessy payment can
  // never be recorded without its receivable, or a receivable without its
  // payment, whether this runs standalone or inside a caller's transaction.
  // Nothing here touches ClientDebt — the patient owes nothing for this portion.
  //
  // The receivable ledger is kept in USD, converted at the rate frozen on this
  // very payment, so settlement can allocate across receivables without per-row
  // currency maths (the native amount stays on the Payment, one join away). The
  // rate is guarded against a missing/zero setting so a misconfiguration can
  // never write Infinity/NaN — the DB's `amount > 0` CHECK would reject that and
  // take the payment down with it. Jessy never carries a card surcharge, so this
  // is the full recorded amount.
  const receivableUsd = tenderToUsd(amountPaid, currency, fxRate);
  const jessyReceivable = input.method === JESSY_METHOD
    ? {
        create: {
          clientId: input.clientId ?? null,
          // Trace the receivable back to the visit it came from, when this
          // payment is settling a basket. Manual payments have no visit.
          consultationId: input.visitBasketId
            ? (
                await client.visitBasket.findUnique({
                  where: { id: input.visitBasketId },
                  select: { consultationId: true },
                })
              )?.consultationId ?? null
            : null,
          amount: receivableUsd,
          remaining: receivableUsd,
          createdByName: input.actorName ?? null,
        },
      }
    : undefined;

  let row: PaymentRow;
  try {
    row = await client.payment.create({
      data: {
        clientId: input.clientId ?? null,
        motif,
        amountPaid,
        currency,
        usdToLbp,
        fxRate,
        cardSurchargeAmount: surcharge,
        method: input.method,
        date: new Date(),
        receiptNumber: await nextReceiptNumber(client),
        idempotencyKey,
        notes: input.notes?.trim() || null,
        createdById: input.createdById ?? null,
        visitBasketId: input.visitBasketId ?? null,
        jessyReceivable,
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
  // A Jessy payment creates an obligation on Jessy, so it gets its own filterable
  // audit line on top of the payment entry below — logged even when `skipAudit`
  // suppresses the generic one (a debt cleared through Jessy is still a new
  // receivable). Identifies the patient by receipt, not by name/contact details.
  if (jessyReceivable) {
    await writeAudit(client, {
      userId: input.createdById ?? null,
      userName: input.actorName,
      action: "Jessy payment recorded",
      entityType: "JessyReceivable",
      entityLabel: `${row.receiptNumber} — ${auditMoney(receivableUsd, "USD")} owed by Jessy`,
    });
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
