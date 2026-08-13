import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { auditMoney, writeAudit } from "./audit";
import { createPayment } from "./payments";
import { getSettings, getUsdToLbp } from "./settings";
import { CLINIC, toUsd } from "@/lib/config";
import {
  fxRateFor,
  round2,
  settlementToleranceUsd,
  tenderToUsd,
  type TenderCurrency,
} from "@/lib/money";
import type { ClientDebt } from "@/lib/types";

/** A debt is an OBLIGATION, so its principal is USD (LBP survives on legacy
 * rows). This is its principal expressed in USD — the figure `paidAmount` is
 * measured against. */
function debtPrincipalUsd(d: { amount: number; currency: string; usdToLbp: number }): number {
  return round2(toUsd(d.amount, d.currency, d.usdToLbp > 0 ? d.usdToLbp : CLINIC.defaultUsdToLbp));
}

/** What is still owed, in USD. Never negative — overpayment is refused, and the
 * DB CHECK backs that up, but a clamp here keeps a corrupt row from producing a
 * negative balance in a report. */
export function debtOutstandingUsd(d: {
  amount: number;
  currency: string;
  usdToLbp: number;
  paidAmount: number;
}): number {
  return Math.max(0, round2(debtPrincipalUsd(d) - d.paidAmount));
}

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
    paidAmount: d.paidAmount,
    outstandingAmount: debtOutstandingUsd(d),
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
  input: {
    method: string;
    // How the money was physically handed over. Omitted => one USD leg for the
    // full outstanding balance (the app's original behaviour, unchanged).
    tender?: { method: string; currency?: TenderCurrency; amount: number }[];
    notes?: string;
    clearedByName?: string | null;
    createdById?: string | null;
  },
): Promise<ClientDebt> {
  await db.$transaction((tx) => clearClientDebtTx(tx, id, input));
  return getClientDebtOrThrow(id);
}

/**
 * The guarded-collect core, run on the caller's transaction so it can be reused
 * atomically — both by the standalone debt-clear route (via clearClientDebt) and
 * by basket settlement, which collects a client's old debt(s) alongside today's
 * charges in one transaction. Records the settlement Payment(s) and a "Debt
 * cleared"/"Debt part-paid" audit entry. Pass `expectedClientId` to reject a debt
 * that doesn't belong to the client being settled.
 *
 * THE DEBT ITSELF IS ALWAYS USD. Money may be tendered in EUR or LBP; each leg is
 * converted at the rate frozen on its own Payment and the USD result reduces the
 * balance. The principal is never re-denominated and never re-priced, so a later
 * rate change cannot make a $400 debt into a $430 one.
 *
 * A collection that does not cover the balance is a PARTIAL payment: `paidAmount`
 * advances and the debt stays outstanding. This is not a convenience — foreign
 * tender rarely lands on the exact balance (€200 against a $400 debt is $182.61),
 * so without it the feature would force the desk to fake an exact amount.
 *
 * Concurrency: both the partial and the full path move the debt with a CONDITIONAL
 * updateMany guarded on the balance/status it was read at, so two clears racing
 * the same debt can never both apply — the loser matches zero rows and throws,
 * rolling back its own payment.
 */
export async function clearClientDebtTx(
  tx: Prisma.TransactionClient,
  id: string,
  input: {
    method: string;
    // Tender legs (method × currency × native amount). Omitted => one USD leg for
    // the full outstanding balance, using `method` — the original behaviour, so
    // every existing caller is untouched.
    tender?: { method: string; currency?: TenderCurrency; amount: number }[];
    notes?: string;
    clearedByName?: string | null;
    createdById?: string | null;
    expectedClientId?: string;
    // Split-settlement mode: the debt's money is already recorded in the
    // settlement's per-method Payment rows (one combined pot, not earmarked), so
    // this clear must NOT mint its own Payment — doing so would double-count the
    // income. When false, we only flip the debt to cleared and audit it,
    // referencing the settlement's receipt(s) via `settlementReceiptRef` instead
    // of a debt-specific receipt. Defaults to true (standalone clear — unchanged).
    recordPayment?: boolean;
    settlementReceiptRef?: string | null;
  },
): Promise<void> {
  const recordPayment = input.recordPayment ?? true;
  const debt = await tx.clientDebt.findUnique({ where: { id } });
  if (!debt) throw new NotFoundError("Debt not found");
  if (input.expectedClientId && debt.clientId !== input.expectedClientId) {
    throw new ConflictError("This debt does not belong to this client.");
  }
  if (debt.status !== "outstanding") {
    throw new ConflictError("This debt has already been settled or voided.");
  }
  const outstandingUsd = debtOutstandingUsd(debt);
  if (!(outstandingUsd > 0)) {
    throw new ConflictError("This debt has already been settled or voided.");
  }

  // Resolve the rates ONCE, inside the caller's transaction, from Settings — never
  // from the request. A caller-supplied rate would be an unaudited discount.
  const rates = await getSettings();

  // Normalize the tender. No legs supplied => the original behaviour: a single USD
  // leg for the whole outstanding balance, using `method`.
  type Leg = { method: string; currency: TenderCurrency; native: number; fxRate: number; usd: number };
  const legs: Leg[] = [];
  if (input.tender && input.tender.length > 0) {
    const byLeg = new Map<string, { method: string; currency: TenderCurrency; native: number }>();
    for (const t of input.tender) {
      const currency: TenderCurrency = t.currency ?? "USD";
      const native = Math.max(0, round2(t.amount ?? 0));
      if (!(native > 0)) continue;
      const key = `${t.method}|${currency}`;
      const prev = byLeg.get(key);
      byLeg.set(key, {
        method: t.method,
        currency,
        native: prev ? round2(prev.native + native) : native,
      });
    }
    for (const l of byLeg.values()) {
      // Throws on an unusable rate rather than valuing the leg 1:1 with the dollar.
      const fxRate = fxRateFor(l.currency, rates);
      legs.push({ ...l, fxRate, usd: tenderToUsd(l.native, l.currency, fxRate) });
    }
  } else {
    legs.push({ method: input.method, currency: "USD", native: outstandingUsd, fxRate: 1, usd: outstandingUsd });
  }
  if (legs.length === 0) throw new ConflictError("Enter an amount to collect.");

  const appliedUsd = round2(legs.reduce((sum, l) => sum + l.usd, 0));
  // Overpayment is REFUSED, not clamped and not turned into a credit — the clinic
  // has no credit-balance or refund concept anywhere, so inventing one here would
  // create money the app can never pay back. Tolerance = the same per-converted-leg
  // rounding allowance settlement uses, so an exact-looking foreign amount that
  // lands a fraction of a cent over is still accepted as an exact clear.
  const tolerance = settlementToleranceUsd(legs);
  if (appliedUsd - outstandingUsd > tolerance) {
    throw new ConflictError(
      `That collects $${appliedUsd.toFixed(2)} against $${outstandingUsd.toFixed(2)} still owed — ` +
        `$${round2(appliedUsd - outstandingUsd).toFixed(2)} too much. The clinic records no credit ` +
        `balances, so reduce the amount collected.`,
    );
  }
  const clearsInFull = outstandingUsd - appliedUsd <= tolerance;

  // Move the debt FIRST, guarded on the exact state it was read at. If a
  // concurrent clear already settled or part-paid it, this matches zero rows and
  // we throw — rolling back the payment(s) created below — so the same money can
  // never be collected twice and two partials can never both apply to a stale
  // balance. Mirrors the settle-basket guard rather than a check-then-update.
  const moved = await tx.clientDebt.updateMany({
    where: { id, status: "outstanding", paidAmount: debt.paidAmount },
    data: clearsInFull
      ? {
          // Snap `paidAmount` to the principal so the row can never carry a
          // fraction-of-a-cent residual that reads as "still owed".
          paidAmount: debtPrincipalUsd(debt),
          status: "cleared",
          clearedAt: new Date(),
          clearedByName: input.clearedByName ?? null,
        }
      : { paidAmount: round2(debt.paidAmount + appliedUsd) },
  });
  if (moved.count === 0) {
    throw new ConflictError("This debt has already been settled or voided.");
  }
  // Standalone clear records its own Payment per leg (each with its own receipt).
  // In split-settlement mode the money already lives in the settlement's own
  // Payment rows, so we skip creating any and reference its receipt in the audit.
  let receiptRef = input.settlementReceiptRef ?? "settlement";
  // 0 unless a standalone card clear adds the clinic's surcharge on top (below) —
  // the principal is always what's needed to clear the debt.
  let cardSurcharge = 0;
  if (recordPayment) {
    const multi = legs.length > 1;
    for (const leg of legs) {
      const payment = await createPayment(
        {
          clientId: debt.clientId,
          motif: `Debt settlement — ${debt.reason}${multi && leg.currency !== "USD" ? ` (${leg.currency})` : ""}`,
          // Native amount in the leg's own currency; createPayment freezes that
          // leg's FX rate and adds any card surcharge natively.
          amountPaid: leg.native,
          currency: leg.currency,
          method: leg.method,
          notes: input.notes,
          createdById: input.createdById ?? null,
          actorName: input.clearedByName,
          // A debt clear logs its own event below, so suppress the generic
          // "Recorded payment" row — one clearly-labeled entry per clear.
          skipAudit: true,
        },
        tx,
      );
      if (receiptRef === (input.settlementReceiptRef ?? "settlement")) {
        receiptRef = payment.receiptNumber;
      }
      // `cardSurchargeAmount` is native to the leg, so fold it to USD at the leg's
      // own rate before summing — adding a EUR fee to a USD fee would be nonsense.
      cardSurcharge = round2(
        cardSurcharge + tenderToUsd(payment.cardSurchargeAmount, leg.currency, leg.fxRate),
      );
    }
  }
  // Distinct, filterable debt-lifecycle event (mirrors the "Voided debt" entry),
  // referencing the settlement receipt so the money is still traceable. Notes the
  // card surcharge separately when one was charged, so the log isn't silent about
  // money that was actually collected on top of the cleared principal, and records
  // the native tender so a foreign-currency collection is auditable to the notes.
  const surchargeNote =
    cardSurcharge > 0 ? ` (+ ${auditMoney(cardSurcharge, "USD")} card surcharge)` : "";
  const tenderNote = legs.some((l) => l.currency !== "USD")
    ? ` [tendered ${legs.map((l) => `${l.native} ${l.currency}`).join(" + ")}]`
    : "";
  const remainingUsd = clearsInFull ? 0 : round2(outstandingUsd - appliedUsd);
  await writeAudit(tx, {
    userId: input.createdById ?? null,
    userName: input.clearedByName,
    action: clearsInFull ? "Debt cleared" : "Debt part-paid",
    entityType: "ClientDebt",
    entityLabel: clearsInFull
      ? `${auditMoney(appliedUsd, "USD")} collected${surchargeNote}${tenderNote} — ${receiptRef} — ${debt.reason}`
      : `${auditMoney(appliedUsd, "USD")} collected${surchargeNote}${tenderNote}, ${auditMoney(remainingUsd, "USD")} still owed — ${receiptRef} — ${debt.reason}`,
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
      // What is actually forgiven is the REMAINING balance — on a part-paid debt
      // the collected portion was already banked and is not being written off.
      entityLabel: `${auditMoney(debtOutstandingUsd(debt), "USD")} written off — ${reason}`,
    });
  });
  return getClientDebtOrThrow(id);
}
