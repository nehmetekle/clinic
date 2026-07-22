import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { basketLineUsd, basketTotals } from "@/lib/utils";
import { CLINIC, toUsd } from "@/lib/config";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { auditMoney, writeAudit } from "./audit";
import { clearClientDebtTx, createClientDebtTx } from "./clientDebts";
import { createPayment } from "./payments";
import { getUsdToLbp } from "./settings";
import { userIdByEmail } from "./staff";
import type {
  Currency,
  PaymentMethod,
  VisitBasket,
  VisitBasketItem,
  VisitBasketStatus,
} from "@/lib/types";

const include = {
  client: true,
  dietitian: true,
  payment: true,
  // Every method portion of the settlement (a split produces several), oldest
  // first, so the settled basket can show the full breakdown with each receipt.
  settlementPayments: { orderBy: { createdAt: "asc" } },
  items: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.VisitBasketInclude;

type VisitBasketRow = Prisma.VisitBasketGetPayload<{ include: typeof include }>;

export type BasketItemInput = {
  kind?: string;
  label: string;
  detail?: string;
  quantity?: number;
  unitPrice?: number;
  currency?: Currency;
  covered?: boolean;
  // Pay-as-you-go session line: the settled (non-covered) quantity advances this
  // plan's sessionsPaid at settlement. null for everything else (packages/products).
  sessionPlanId?: string | null;
};

/** Normalizes a basket item payload into a row create object. */
function itemCreate(i: BasketItemInput) {
  return {
    kind: i.kind ?? "custom",
    label: i.label,
    detail: i.detail || null,
    quantity: Math.max(1, Math.floor(i.quantity ?? 1)),
    unitPrice: Math.max(0, i.unitPrice ?? 0),
    currency: i.currency ?? "USD",
    covered: i.covered ?? false,
    sessionPlanId: i.sessionPlanId ?? null,
  };
}

export function toVisitBasket(b: VisitBasketRow): VisitBasket {
  const items: VisitBasketItem[] = b.items.map((i) => ({
    id: i.id,
    kind: i.kind as VisitBasketItem["kind"],
    label: i.label,
    detail: i.detail ?? undefined,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    currency: asCurrency(i.currency),
    covered: i.covered,
    sessionPlanId: i.sessionPlanId ?? undefined,
  }));
  const totals = basketTotals(
    items,
    {
      type: (b.discountType ?? undefined) as "percent" | "amount" | undefined,
      value: b.discountValue,
    },
    b.usdToLbp > 0 ? b.usdToLbp : CLINIC.defaultUsdToLbp,
  );
  return {
    id: b.id,
    clientId: b.clientId,
    clientName: `${b.client.firstName} ${b.client.lastName}`,
    consultationId: b.consultationId ?? undefined,
    dietitianName: b.dietitian?.fullName ?? "Unassigned",
    status: b.status as VisitBasketStatus,
    discountType: (b.discountType ?? undefined) as VisitBasket["discountType"],
    discountValue: b.discountValue,
    discountReason: b.discountReason ?? undefined,
    currency: asCurrency(b.currency),
    usdToLbp: b.usdToLbp,
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    sentAt: b.sentAt.toISOString(),
    paidAt: b.paidAt?.toISOString(),
    paymentId: b.paymentId ?? undefined,
    receiptNumber: b.payment?.receiptNumber ?? undefined,
    paymentSplits: b.settlementPayments.length
      ? b.settlementPayments.map((p) => ({
          method: p.method as PaymentMethod,
          amount: p.amountPaid,
          receiptNumber: p.receiptNumber,
        }))
      : undefined,
  };
}

export type UpsertBasketInput = {
  clientId: string;
  dietitianId?: string | null;
  consultationId: string;
  discountType?: "percent" | "amount" | null;
  discountValue?: number;
  discountReason?: string | null;
  currency?: Currency;
  items: BasketItemInput[];
};

/** Identity used to match a re-sent item against one already paid today. */
function itemSignature(i: {
  kind?: string;
  label: string;
  unitPrice?: number;
  covered?: boolean;
}): string {
  return [i.kind ?? "custom", i.label.trim().toLowerCase(), i.unitPrice ?? 0, i.covered ? 1 : 0].join("::");
}

/**
 * Reduces the incoming items by whatever was already paid on this consultation,
 * so a re-save only charges the items/quantities that weren't paid before.
 * Quantities are netted: paying 1 of a product then re-adding 3 leaves 2 to pay.
 */
async function remainingUnpaidItems(
  tx: Prisma.TransactionClient,
  consultationId: string,
  items: BasketItemInput[],
): Promise<BasketItemInput[]> {
  const paidBaskets = await tx.visitBasket.findMany({
    where: { consultationId, status: "paid" },
    include: { items: true },
  });

  const paidQty = new Map<string, number>();
  for (const basket of paidBaskets) {
    for (const item of basket.items) {
      const sig = itemSignature(item);
      paidQty.set(sig, (paidQty.get(sig) ?? 0) + item.quantity);
    }
  }

  const remaining: BasketItemInput[] = [];
  for (const item of items) {
    const sig = itemSignature(item);
    const already = paidQty.get(sig) ?? 0;
    const qty = Math.max(1, Math.floor(item.quantity ?? 1));
    if (already >= qty) {
      paidQty.set(sig, already - qty); // fully covered by an earlier payment
      continue;
    }
    remaining.push({ ...item, quantity: qty - already });
    paidQty.set(sig, 0);
  }
  return remaining;
}

/**
 * Idempotent per consultation: a consultation has at most one *pending* delta
 * basket, so re-saving replaces its contents rather than piling up duplicates —
 * and anything already paid in an earlier installment is netted out so only the
 * newly added items remain. Returns the basket id, or `null` when nothing new is
 * left to charge. Runs inside the caller's transaction so
 * buildConsultationContentTx can reuse it atomically on save.
 */
export async function upsertPendingBasketTx(
  tx: Prisma.TransactionClient,
  input: UpsertBasketInput,
): Promise<string | null> {
  const remaining = await remainingUnpaidItems(tx, input.consultationId, input.items);

  // The one pending delta belongs to this consultation (evolving visit).
  const existing = await tx.visitBasket.findFirst({
    where: { consultationId: input.consultationId, status: "pending" },
    orderBy: { sentAt: "desc" },
  });

  // Nothing new to charge: drop any stale pending basket and signal "no basket".
  if (remaining.length === 0) {
    if (existing) await tx.visitBasket.delete({ where: { id: existing.id } });
    return null;
  }

  const discountApplied = Boolean(input.discountType) && (input.discountValue ?? 0) > 0;
  const base = {
    dietitianId: input.dietitianId ?? null,
    discountType: input.discountType ?? null,
    discountValue: input.discountValue ?? 0,
    // Only keep a reason when a discount is actually applied.
    discountReason: discountApplied ? input.discountReason ?? null : null,
    currency: input.currency ?? "USD",
  };

  if (existing) {
    await tx.visitBasketItem.deleteMany({ where: { basketId: existing.id } });
    await tx.visitBasket.update({
      where: { id: existing.id },
      data: {
        ...base,
        consultationId: input.consultationId,
        sentAt: new Date(),
        items: { create: remaining.map(itemCreate) },
      },
    });
    return existing.id;
  }

  const created = await tx.visitBasket.create({
    data: {
      clientId: input.clientId,
      consultationId: input.consultationId,
      status: "pending",
      ...base,
      // Freeze the live rate at creation so the basket total never re-prices
      // (set on create only — re-sends update items but never the rate).
      usdToLbp: await getUsdToLbp(),
      items: { create: remaining.map(itemCreate) },
    },
  });
  return created.id;
}

/**
 * Records a basket that is ALREADY settled at $0 — used when a per-session visit
 * is fully covered by prepaid session credit. It gives the visit a full audit
 * trail (the covered session lines) without any secretary checkout. No payment
 * row is created (nothing was charged) and no sessionsPaid increment happens
 * (credit was consumed, not newly paid — that already happened when it was
 * prepaid). Runs inside the consultation's transaction.
 */
export async function createSettledBasketTx(
  tx: Prisma.TransactionClient,
  input: {
    clientId: string;
    dietitianId?: string | null;
    consultationId?: string | null;
    currency?: Currency;
    items: BasketItemInput[];
  },
): Promise<string> {
  const created = await tx.visitBasket.create({
    data: {
      clientId: input.clientId,
      dietitianId: input.dietitianId ?? null,
      consultationId: input.consultationId ?? null,
      status: "paid",
      currency: input.currency ?? "USD",
      usdToLbp: await getUsdToLbp(),
      sentAt: new Date(),
      paidAt: new Date(),
      items: { create: input.items.map(itemCreate) },
    },
  });
  return created.id;
}

async function getVisitBasketOrThrow(id: string): Promise<VisitBasket> {
  const basket = await getVisitBasket(id);
  if (!basket) throw new NotFoundError("Basket not found");
  return basket;
}

export async function listVisitBaskets(
  opts: { status?: VisitBasketStatus; clientId?: string } = {},
): Promise<VisitBasket[]> {
  const rows = await db.visitBasket.findMany({
    where: { status: opts.status, clientId: opts.clientId },
    include,
    orderBy: { sentAt: "desc" },
  });
  return rows.map(toVisitBasket);
}

export async function getVisitBasket(id: string): Promise<VisitBasket | null> {
  const row = await db.visitBasket.findUnique({ where: { id }, include });
  return row ? toVisitBasket(row) : null;
}

/** Compact "kind × label × unit price" label for a basket line in an audit entry. */
function auditLineLabel(i: { label: string; quantity: number; unitPrice: number; currency: string }): string {
  const qty = i.quantity > 1 ? ` ×${i.quantity}` : "";
  return `${i.label}${qty} (${auditMoney(i.unitPrice * i.quantity, i.currency)})`;
}

type DiffLine = { label: string; quantity: number; unitPrice: number; currency: string };

/**
 * Summarizes what changed between the lines the dietitian sent (`existingRows`)
 * and what the secretary is saving (`incoming`) — added, removed, and quantity
 * changes — as one compact audit string, or null when nothing changed. The
 * consultation-fee line is excluded (its waive is logged on its own).
 */
function diffBasketItems(
  existingRows: { kind: string; label: string; quantity: number; unitPrice: number; currency: string; covered: boolean }[],
  incoming: BasketItemInput[],
  lineSig: (i: { kind?: string | null; label: string; unitPrice?: number | null; covered?: boolean | null }) => string,
): string | null {
  const isFee = (kind?: string | null) => (kind ?? "custom") === "consultation_fee";
  const fold = (map: Map<string, DiffLine>, sig: string, line: DiffLine) => {
    const prev = map.get(sig);
    map.set(sig, prev ? { ...prev, quantity: prev.quantity + line.quantity } : line);
  };

  const exMap = new Map<string, DiffLine>();
  for (const i of existingRows) {
    if (isFee(i.kind)) continue;
    fold(exMap, lineSig(i), { label: i.label, quantity: i.quantity, unitPrice: i.unitPrice, currency: i.currency });
  }
  const inMap = new Map<string, DiffLine>();
  for (const i of incoming) {
    if (isFee(i.kind)) continue;
    fold(inMap, lineSig(i), {
      label: i.label,
      quantity: Math.max(1, Math.floor(i.quantity ?? 1)),
      unitPrice: Math.max(0, i.unitPrice ?? 0),
      currency: i.currency ?? "USD",
    });
  }

  const added: string[] = [];
  const changed: string[] = [];
  for (const [sig, inItem] of inMap) {
    const ex = exMap.get(sig);
    if (!ex) added.push(auditLineLabel(inItem));
    else if (ex.quantity !== inItem.quantity) changed.push(`${inItem.label} ${ex.quantity}→${inItem.quantity}`);
  }
  const removed: string[] = [];
  for (const [sig, exItem] of exMap) {
    if (!inMap.has(sig)) removed.push(auditLineLabel(exItem));
  }

  const parts: string[] = [];
  if (added.length) parts.push(`Added: ${added.join(", ")}`);
  if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
  if (changed.length) parts.push(`Qty: ${changed.join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

/**
 * Secretary edits a pending basket's items/discount before settling. The
 * consultation fee is protected: only an admin (or the dietitian, in their own
 * editor) may drop it — a secretary attempt is rejected. Every other item change
 * (add/remove/quantity) vs. what the dietitian sent is recorded to the audit log.
 */
export async function updateVisitBasket(
  id: string,
  input: {
    discountType?: "percent" | "amount" | null;
    discountValue?: number;
    discountReason?: string | null;
    currency?: Currency;
    items: BasketItemInput[];
  },
  actor?: { name?: string | null; email?: string | null; role?: string | null },
): Promise<VisitBasket> {
  const existing = await db.visitBasket.findUnique({
    where: { id },
    include: { items: true, client: true, dietitian: true },
  });
  if (!existing) throw new NotFoundError("Basket not found");
  if (existing.status === "paid") {
    throw new ConflictError("This basket is already paid and can't be edited.");
  }

  // Line identity for diffing/protection: kind + label + unit price (+ covered).
  // Quantity is compared separately so a quantity change reads as an edit, not a
  // remove+add. Mirrors the settlement netting signature used elsewhere.
  const lineSig = (i: { kind?: string | null; label: string; unitPrice?: number | null; covered?: boolean | null }) =>
    itemSignature({ kind: i.kind ?? "custom", label: i.label, unitPrice: i.unitPrice ?? 0, covered: i.covered ?? false });

  // Consultation-fee protection (F: only dietitian/admin may waive it). Compare
  // the fee line(s) the dietitian sent against what's coming back: if any are
  // missing or altered, a secretary is blocked outright; an admin is allowed but
  // the waive is logged.
  const existingFee = existing.items.filter((i) => i.kind === "consultation_fee");
  const incomingFeeSigs = new Set(
    input.items.filter((i) => (i.kind ?? "custom") === "consultation_fee").map(lineSig),
  );
  const feeWaivedHere = existingFee.some((i) => !incomingFeeSigs.has(lineSig(i)));
  if (feeWaivedHere && actor?.role !== "admin") {
    throw new ConflictError(
      "Only the dietitian or an admin can remove the consultation fee.",
    );
  }

  const nextType = input.discountType ?? null;
  const nextValue = input.discountValue ?? 0;
  const discountApplied = Boolean(nextType) && nextValue > 0;
  const nextReason = discountApplied ? input.discountReason ?? null : null;
  // Log only when a discount is present AND actually changed from before, so
  // re-saving a basket with an unchanged discount doesn't spam the audit log.
  const discountChanged =
    (existing.discountType ?? null) !== nextType ||
    existing.discountValue !== nextValue ||
    (existing.discountReason ?? null) !== nextReason;

  // Diff incoming items vs. what the dietitian sent (the currently stored lines),
  // so the secretary's add/remove/quantity edits are recorded for the admin.
  const clientName = `${existing.client.firstName} ${existing.client.lastName}`;
  const dietitianName = existing.dietitian?.fullName ?? "Unassigned";
  const editSummary = diffBasketItems(existing.items, input.items, lineSig);

  await db.$transaction(async (tx) => {
    await tx.visitBasketItem.deleteMany({ where: { basketId: id } });
    await tx.visitBasket.update({
      where: { id },
      data: {
        discountType: nextType,
        discountValue: nextValue,
        discountReason: nextReason,
        currency: input.currency ?? "USD",
        items: { create: input.items.map(itemCreate) },
      },
    });

    // Admin waived the consultation fee at settlement — record who/what/when.
    if (feeWaivedHere) {
      const fee = existingFee[0];
      await writeAudit(tx, {
        userId: await userIdByEmail(actor?.email ?? undefined),
        userName: actor?.name,
        action: "Consultation fee waived",
        entityType: "VisitBasket",
        entityLabel: `${clientName} (client) · ${dietitianName} (dietitian) — consultation fee ${auditMoney(fee?.unitPrice ?? 0, fee?.currency ?? "USD")} waived at settlement`,
      });
    }

    // Record the secretary's basket edits (added / removed / quantity changes)
    // against what the dietitian sent, excluding the fee line already logged above.
    if (editSummary) {
      await writeAudit(tx, {
        userId: await userIdByEmail(actor?.email ?? undefined),
        userName: actor?.name,
        action: "Edited basket",
        entityType: "VisitBasket",
        entityLabel: `${clientName} — ${editSummary}`,
      });
    }

    if (discountApplied && discountChanged) {
      const rate = existing.usdToLbp > 0 ? existing.usdToLbp : CLINIC.defaultUsdToLbp;
      const money = basketTotals(
        input.items.map((i) => ({
          quantity: Math.max(1, Math.floor(i.quantity ?? 1)),
          unitPrice: Math.max(0, i.unitPrice ?? 0),
          covered: i.covered ?? false,
          currency: i.currency ?? "USD",
        })),
        { type: nextType, value: nextValue },
        rate,
      ).discount;
      const configured = nextType === "percent" ? `${nextValue}%` : auditMoney(nextValue, input.currency);
      await writeAudit(tx, {
        userId: await userIdByEmail(actor?.email ?? undefined),
        userName: actor?.name,
        action: "Applied discount",
        entityType: "VisitBasket",
        entityLabel: `${configured} (${auditMoney(money, "USD")}) off — ${nextReason ?? "no reason"}`,
      });
    }
  });
  return getVisitBasketOrThrow(id);
}

/**
 * Secretary settles the basket: records a real payment for the (post-discount)
 * total and flips the basket to paid. A zero-total basket (all package-covered)
 * is marked paid without creating a payment row.
 *
 * The payment and the status flip run in ONE transaction, so they can never end
 * up half-done: if anything fails partway (a crash, a DB error), the whole thing
 * rolls back — no orphan payment, the basket stays pending — and the secretary
 * can safely retry. The flip is a conditional update guarded on `status:
 * "pending"`; if a concurrent settle already paid the basket, the guard matches
 * zero rows and we throw, which rolls back the just-created payment. That closes
 * the double-charge window even under simultaneous requests.
 */
export async function settleVisitBasket(
  id: string,
  input: {
    // How the collected money was tendered, split across one or more methods. The
    // portions must sum (in USD) to everything actually collected in this
    // settlement = today's basket total (minus any deferred debt) + any existing
    // debts collected alongside. Each portion becomes its own single-method
    // Payment row so the payment-method breakdown stays exact. A single-method
    // settlement is just one split entry. Empty/omitted only when nothing is
    // collected (a fully deferred/covered basket).
    splits?: { method: string; amount: number }[];
    notes?: string;
    createdById?: string | null;
    actorName?: string | null;
    // Secretary override: the client couldn't cover everything today, so record
    // what's still owed as a tracked ClientDebt alongside the payment for what was
    // actually collected. Session-plan shortfalls are already tracked on the plan,
    // so the secretary should enter only the non-plan remainder here.
    debtAmount?: number;
    debtReason?: string;
    // The client's existing outstanding ClientDebt(s) the secretary chose to
    // collect alongside today's charges (the auto-suggested debt line). Each is
    // cleared in full through the same hardened path as a standalone debt clear —
    // its own Payment + "Debt cleared" audit — inside this settle transaction.
    clearDebtIds?: string[];
  },
): Promise<VisitBasket> {
  await db.$transaction(async (tx) => {
    const row = await tx.visitBasket.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundError("Basket not found");
    if (row.status === "paid") throw new ConflictError("This basket is already settled.");

    const view = toVisitBasket(row);

    // Entering a debt REDUCES what's recorded as collected — it never adds on top
    // of a full payment (which would double-count the same money as both income and
    // owed). Session-plan charged lines are collected in full here (they advance the
    // plan below) and are tracked by the plan's own sessionsPaid gap, not by a
    // ClientDebt — so only the non-plan portion of today's total may be deferred.
    // Cap the entered debt at that deferrable portion so the recorded income can
    // never exceed what was actually paid, and a session can never be both "paid on
    // the plan" and "owed as debt".
    const rate = row.usdToLbp > 0 ? row.usdToLbp : CLINIC.defaultUsdToLbp;
    const planPortion = row.items
      .filter((i) => i.sessionPlanId && !i.covered)
      .reduce((s, i) => s + basketLineUsd(i, rate), 0);
    const deferrable = Math.max(0, Math.round((view.total - planPortion) * 100) / 100);
    const debtAmount = Math.max(0, input.debtAmount ?? 0);
    if (debtAmount > deferrable) {
      throw new ConflictError(
        "The recorded debt can't exceed the non-session-plan balance owed on this basket.",
      );
    }

    // Today's portion the client actually handed over = today's total minus the
    // deferred debt. A fully-deferred basket ($0 today) records nothing for today —
    // the whole balance lives on the ClientDebt created below.
    const todayCollected = Math.max(0, Math.round((view.total - debtAmount) * 100) / 100);

    // Existing debts the secretary is collecting in the SAME settlement. Their USD
    // value folds into the same combined pot the split must cover (money is handed
    // over as one amount, not earmarked per source). Fetched + client-scoped here
    // so a stray/foreign id is rejected before any money is recorded.
    const clearDebtIds = input.clearDebtIds ?? [];
    const debtsToCollect = clearDebtIds.length
      ? await tx.clientDebt.findMany({ where: { id: { in: clearDebtIds } } })
      : [];
    for (const d of debtsToCollect) {
      if (d.clientId !== row.clientId) {
        throw new ConflictError("This debt does not belong to this client.");
      }
    }
    const oldDebtUsd = debtsToCollect.reduce(
      (s, d) => s + toUsd(d.amount, d.currency, d.usdToLbp > 0 ? d.usdToLbp : rate),
      0,
    );

    // The single combined amount actually collected now (USD), across every method.
    const combinedCollected = Math.round((todayCollected + oldDebtUsd) * 100) / 100;

    // Normalize the split: fold duplicate methods, drop zero/negative portions.
    const byMethod = new Map<string, number>();
    for (const s of input.splits ?? []) {
      const amt = Math.max(0, Math.round((s.amount ?? 0) * 100) / 100);
      if (amt <= 0) continue;
      byMethod.set(s.method, Math.round(((byMethod.get(s.method) ?? 0) + amt) * 100) / 100);
    }
    const splitTotal = Math.round([...byMethod.values()].reduce((s, a) => s + a, 0) * 100) / 100;

    // HARD validation (authoritative — mirrors the debt-cap check): the split must
    // sum EXACTLY to what's being collected. Blocks a settlement that doesn't add
    // up, so recorded income can never drift from the money actually taken.
    if (Math.abs(splitTotal - combinedCollected) > 0.005) {
      throw new ConflictError(
        `The payment split (${splitTotal.toFixed(2)}) must add up to the amount being collected (${combinedCollected.toFixed(2)}).`,
      );
    }

    // Each method portion becomes its own single-method Payment row, all linked to
    // this basket, so the payment-method breakdown reports the split correctly and
    // every portion carries its own receipt + audit entry.
    const labels = view.items.filter((i) => !i.covered).map((i) => i.label);
    const baseLabel =
      labels.length <= 3
        ? labels.join(", ")
        : `${labels.slice(0, 3).join(", ")} +${labels.length - 3} more`;
    const withBalance = oldDebtUsd > 0 ? " + previous balance" : "";
    const baseMotif = todayCollected > 0
      ? `Visit charges — ${baseLabel}${withBalance}`
      : `Previous balance settled`;
    const multi = byMethod.size > 1;

    let paymentId: string | null = null;
    let primaryReceipt: string | null = null;
    for (const [method, amount] of byMethod) {
      const motif = multi ? `${baseMotif} (${PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method})` : baseMotif;
      const payment = await createPayment(
        {
          clientId: row.clientId,
          motif,
          amountPaid: amount,
          // Split amounts are USD (basketTotals + debt values normalize to USD).
          currency: "USD",
          method,
          notes: input.notes,
          createdById: input.createdById ?? null,
          actorName: input.actorName,
          visitBasketId: id,
        },
        tx,
      );
      if (!paymentId) {
        paymentId = payment.id;
        primaryReceipt = payment.receiptNumber;
      }
    }

    // Flip only if still pending. A concurrent settle that already paid it makes
    // this match zero rows → we throw → the payment created above rolls back, so
    // the basket is never charged twice.
    const flipped = await tx.visitBasket.updateMany({
      where: { id, status: "pending" },
      data: { status: "paid", paidAt: new Date(), paymentId },
    });
    if (flipped.count === 0) {
      throw new ConflictError("This basket is already settled.");
    }

    // Pay-as-you-go session plans (SEPARATE from Packages): the FINAL settled
    // quantity of each charged session line advances that plan's sessionsPaid.
    // `row.items` was read fresh at the top of this transaction, so it reflects
    // any quantity edits the secretary saved before settling — and it commits in
    // the same transaction as the payment, so counts and money can't drift apart.
    const paidByPlan = new Map<string, number>();
    for (const item of row.items) {
      if (item.sessionPlanId && !item.covered) {
        paidByPlan.set(item.sessionPlanId, (paidByPlan.get(item.sessionPlanId) ?? 0) + item.quantity);
      }
    }
    for (const [planId, qty] of paidByPlan) {
      const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
      // Only credit a plan that belongs to this basket's client.
      if (!plan || plan.clientId !== row.clientId) continue;
      await tx.sessionPlan.update({
        where: { id: planId },
        data: { sessionsPaid: plan.sessionsPaid + qty },
      });
    }

    // Secretary override: record the deferred (already subtracted from `collected`)
    // remainder as a tracked debt in the same transaction as the payment, linked to
    // this basket's visit. collected + debtAmount always equals today's total.
    if (debtAmount > 0) {
      await createClientDebtTx(tx, {
        clientId: row.clientId,
        consultationId: row.consultationId,
        amount: debtAmount,
        currency: asCurrency(row.currency),
        usdToLbp: row.usdToLbp,
        reason: input.debtReason?.trim() || "Balance still owed at settlement",
        source: "secretary_override",
        createdByName: input.actorName ?? null,
      });
    }

    // Collect the client's chosen existing debt(s) in the same transaction. Their
    // money is already in the per-method Payment rows above (one combined pot), so
    // each clear runs in PAYMENTLESS mode — it flips the debt to cleared and writes
    // its "Debt cleared" audit referencing the settlement receipt(s), without
    // minting a second Payment (which would double-count the income). Still scoped
    // to this client via the shared guarded-clear core so a stray id can't settle
    // another client's debt. Old debts clear in full — today's charges are the only
    // deferrable part.
    for (const debtId of clearDebtIds) {
      await clearClientDebtTx(tx, debtId, {
        method: byMethod.keys().next().value ?? "cash",
        clearedByName: input.actorName,
        createdById: input.createdById ?? null,
        expectedClientId: row.clientId,
        recordPayment: false,
        settlementReceiptRef: primaryReceipt,
      });
    }
  });

  return getVisitBasketOrThrow(id);
}
