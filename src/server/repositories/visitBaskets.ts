import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { allocateDiscount, basketLineUsd, basketTotals } from "@/lib/utils";
import { CLINIC, toUsd } from "@/lib/config";
import {
  StaleFxRateError,
  describeStaleRates,
  detectStaleRates,
  frozenPaymentFxRate,
  fxRateFor,
  round2,
  settlementToleranceUsd,
  tenderToUsd,
  type TenderCurrency,
} from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { auditMoney, writeAudit } from "./audit";
import { clearClientDebtTx, createClientDebtTx } from "./clientDebts";
import { createPayment } from "./payments";
import { adjustProductStockTx } from "./products";
import { creditSessionPlanPaidTx } from "./sessionCounters";
import { getSettings, getUsdToLbp } from "./settings";
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
  // Permanent catalog reference for a "product" line — the final settled quantity
  // per productId is what settleVisitBasket deducts from inventory. null for
  // everything else (blood tests/treatments/custom lines never map to a Product).
  productId?: string | null;
  // The prepaid bundle this line sells. Makes the bundle line traceable to the
  // ClientPackage it created — and price-protectable like any other catalog line.
  clientPackageId?: string | null;
  // The ConsultationBotoxItem this "botox" line sells — makes it traceable and
  // price-protectable exactly like productId/clientPackageId/sessionPlanId
  // above. null for everything else.
  consultationBotoxItemId?: string | null;
  // Clinic cost per unit, frozen from the same source that supplied `unitPrice`.
  unitCost?: number;
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
    // Frozen at the same moment as unitPrice, from the same source row.
    unitCost: Math.max(0, i.unitCost ?? 0),
    sessionPlanId: i.sessionPlanId ?? null,
    productId: i.productId ?? null,
    clientPackageId: i.clientPackageId ?? null,
    consultationBotoxItemId: i.consultationBotoxItemId ?? null,
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
    // The line's frozen share of the bill discount. Exposed so the base price,
    // the reduction and the resulting sale value are all separately visible on a
    // settled basket. `unitCost` is deliberately NOT exposed — the clinic's cost
    // is admin-only, like every other cost in this app.
    discountAmount: i.discountAmount,
    sessionPlanId: i.sessionPlanId ?? undefined,
    productId: i.productId ?? undefined,
    clientPackageId: i.clientPackageId ?? undefined,
    consultationBotoxItemId: i.consultationBotoxItemId ?? undefined,
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
    dietitianId: b.dietitianId ?? undefined,
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
      ? b.settlementPayments.map((p) => {
          // Value every leg at ITS OWN frozen rate, never today's — this is what
          // a settled basket (and any receipt built from it) must show forever.
          const { currency, fxRate } = frozenPaymentFxRate(p);
          // The basket-attributable portion — excludes the card surcharge, so
          // every split's amount still sums to `total` above, same as what the
          // secretary entered. The fee itself (0 for non-card) is separate.
          const nativeNet = round2(p.amountPaid - p.cardSurchargeAmount);
          return {
            method: p.method as PaymentMethod,
            currency,
            nativeAmount: nativeNet,
            fxRate,
            amount: tenderToUsd(nativeNet, currency, fxRate),
            cardSurchargeAmount: p.cardSurchargeAmount,
            receiptNumber: p.receiptNumber,
          };
        })
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
      "Only the doctor or an admin can remove the consultation fee.",
    );
  }

  // Session-plan lines are locked at checkout. Their settled quantity is what
  // UNLOCKS sessions on the plan, so retyping one here would hand the patient a
  // different number of sessions than was sold, and inventing one would unlock
  // sessions nobody sold. The lines the dietitian (or the sale) sent must come
  // back byte-for-byte. Enforced on the SERVER, not just locked in the settlement
  // modal, so a direct PATCH can't bypass it. Deferring the money to a debt is
  // still allowed — that settles the basket without changing what was sold.
  const planLineFingerprint = (
    rows: {
      sessionPlanId?: string | null;
      label: string;
      quantity?: number | null;
      unitPrice?: number | null;
      currency?: string | null;
      covered?: boolean | null;
    }[],
  ): string[] =>
    rows
      .filter((i) => i.sessionPlanId)
      .map((i) =>
        [
          i.sessionPlanId,
          i.label.trim().toLowerCase(),
          Math.max(1, Math.floor(i.quantity ?? 1)),
          i.unitPrice ?? 0,
          i.currency ?? "USD",
          i.covered ? 1 : 0,
        ].join("::"),
      )
      .sort();
  const planBefore = planLineFingerprint(existing.items);
  const planAfter = planLineFingerprint(input.items);
  if (planBefore.length !== planAfter.length || planBefore.some((sig, idx) => sig !== planAfter[idx])) {
    throw new ConflictError(
      "Session-plan sessions are paid upfront in full — their lines can't be changed at checkout.",
    );
  }

  // THE BASE PRICE OF A CATALOG-BACKED LINE IS NOT EDITABLE. A DISCOUNT IS NOT A
  // PRICE EDIT.
  //
  // Every line whose price came from a source — the service catalog, a session
  // plan, a product, a prepaid bundle, the doctor's consultation fee — must come
  // back at exactly the price that source gave it. Retyping it here would make the
  // bill disagree with the item it is billing for, destroy the audit trail of what
  // the thing actually costs, and (for a bundle) silently redefine the economics
  // frozen onto the ClientPackage.
  //
  // Reducing what the client pays is fully supported and unaffected — through the
  // discount, which is stored separately and leaves the original price standing.
  // Only genuinely ad-hoc lines the desk adds itself (kind "custom") carry a price
  // the desk is allowed to set, because there is no source to disagree with.
  //
  // Enforced on the SERVER, so a direct PATCH cannot bypass what the settlement
  // screen disables.
  const SOURCED_KINDS = new Set(["consultation_fee", "blood_test", "treatment", "product", "package", "botox"]);
  const isSourced = (i: {
    kind?: string | null;
    sessionPlanId?: string | null;
    productId?: string | null;
    clientPackageId?: string | null;
    consultationBotoxItemId?: string | null;
  }) =>
    SOURCED_KINDS.has(i.kind ?? "custom") ||
    Boolean(i.sessionPlanId) ||
    Boolean(i.productId) ||
    Boolean(i.clientPackageId) ||
    Boolean(i.consultationBotoxItemId);
  // Identity deliberately EXCLUDES price: that is the whole point — we are looking
  // for the same line coming back at a different price, which a price-inclusive
  // signature would read as an unrelated line and wave through.
  //
  // Prefer a real catalog FK when the line carries one: `label` is a display name
  // with no uniqueness guarantee (two Products, or two ClientPackage purchases of
  // the same package, can share a name), so keying on label alone can attach one
  // line's frozen price/cost to a different catalog row of the same name. Only
  // genuinely unsourced lines (no FK at all — e.g. "custom") fall back to it.
  const priceKey = (i: {
    kind?: string | null;
    label: string;
    covered?: boolean | null;
    productId?: string | null;
    clientPackageId?: string | null;
    sessionPlanId?: string | null;
    consultationBotoxItemId?: string | null;
  }) =>
    i.productId
      ? `product::${i.productId}`
      : i.clientPackageId
        ? `package::${i.clientPackageId}`
        : i.sessionPlanId
          ? `plan::${i.sessionPlanId}`
          : i.consultationBotoxItemId
            ? `botox::${i.consultationBotoxItemId}`
            : `${i.kind ?? "custom"}::${i.label.trim().toLowerCase()}::${i.covered ? 1 : 0}`;
  const sourcedPrices = new Map<string, number>();
  for (const i of existing.items) {
    if (isSourced(i)) sourcedPrices.set(priceKey(i), i.unitPrice);
  }
  for (const i of input.items) {
    if (!isSourced(i)) continue;
    const original = sourcedPrices.get(priceKey(i));
    // A brand-new sourced line. Only a reference to a REAL catalog/consultation
    // row needs protecting here — that's what "sourced" is supposed to mean:
    // something with a price that could disagree with reality, or that unlocks
    // real consumption downstream (inventory, a bundle, a session plan, a
    // doctor-priced Botox charge). A line that only matched SOURCED_KINDS by
    // its `kind` NAME (e.g. a desk-added "product"/"treatment" line with no
    // catalog id at all) has no such row to disagree with and triggers no
    // consumption — settleVisitBasket only touches inventory/plans/bundles via
    // productId/sessionPlanId/clientPackageId, never via `kind` alone — so it's
    // priced like a "custom" line, same as always.
    //
    // A newly added PRODUCT line is re-priced from the catalog below
    // (withCatalogPriceAndCost), never trusted from the request — that closes
    // the actual theft vector (ring up a real product at a fabricated price
    // while settlement still deducts the real quantity from stock). A
    // session-plan/bundle reference is caught by the dedicated fingerprint
    // checks elsewhere in this function (planLineFingerprint above,
    // packageFingerprint below) — both key off the FK itself, not `kind`. A
    // Botox reference is refused outright here, checked off the FK
    // (`consultationBotoxItemId`) as well as `kind`, so a request can't dodge
    // this by mislabeling `kind` on a line that still carries a real Botox id.
    if (original === undefined) {
      if (i.kind === "botox" || i.consultationBotoxItemId) {
        throw new ConflictError(
          `"${i.label}" can't be added here — Botox charges are set by the doctor in the consultation, not at checkout.`,
        );
      }
      continue;
    }
    if ((i.unitPrice ?? 0) !== original) {
      throw new ConflictError(
        `"${i.label}" is priced from the catalog and can't be re-priced at checkout. ` +
          `Apply a discount instead — the original price stays on the bill and the ` +
          `reduction is recorded separately.`,
      );
    }
  }

  // A prepaid bundle line is fixed in full: its price AND its quantity define the
  // ClientPackage that was created when it was sold, so neither can move here.
  const packageFingerprint = (
    rows: { clientPackageId?: string | null; quantity?: number | null; unitPrice?: number | null }[],
  ): string[] =>
    rows
      .filter((i) => i.clientPackageId)
      .map((i) => [i.clientPackageId, Math.max(1, Math.floor(i.quantity ?? 1)), i.unitPrice ?? 0].join("::"))
      .sort();
  const pkgBefore = packageFingerprint(existing.items);
  const pkgAfter = packageFingerprint(input.items);
  if (pkgBefore.length !== pkgAfter.length || pkgBefore.some((sig, idx) => sig !== pkgAfter[idx])) {
    throw new ConflictError(
      "A prepaid bundle is sold at its agreed package price — its line can't be changed at checkout. " +
        "Apply a discount instead.",
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

  // COST IS NEVER ACCEPTED FROM THE REQUEST, and this rebuild must not lose it.
  // `updateVisitBasket` deletes and recreates every line, so without this the
  // round-trip through the settlement screen — which has no cost field, by design
  // — would silently reset every frozen `unitCost` to 0 and report the whole visit
  // as pure margin. Each surviving line carries its own cost forward from the row
  // the dietitian sent; a line the secretary adds here resolves its cost
  // server-side from the catalog, the same way its price is resolved.
  //
  // PRICE for a brand-new product line is ALSO resolved here, from the same
  // catalog row, rather than trusted from the request — the loop above only
  // refused a new sourced line that ISN'T a plain product; this is what
  // actually prices the product lines it let through. Without this, a request
  // could ring up a real product at any `unitPrice` it likes (a clean
  // under-ringing / inventory-theft vector, since settlement still deducts the
  // full quantity from stock regardless of what was charged for it).
  const sourcedCosts = new Map<string, number>();
  for (const i of existing.items) sourcedCosts.set(priceKey(i), i.unitCost);
  const addedProductIds = [
    ...new Set(
      input.items
        .filter((i) => i.productId && sourcedPrices.get(priceKey(i)) === undefined)
        .map((i) => i.productId as string),
    ),
  ];
  const addedProductCatalog = new Map<string, { price: number; cost: number }>();
  if (addedProductIds.length > 0) {
    const rows = await db.product.findMany({
      where: { id: { in: addedProductIds } },
      select: { id: true, price: true, cost: true },
    });
    for (const r of rows) addedProductCatalog.set(r.id, { price: r.price, cost: r.cost });
  }
  const withCatalogPriceAndCost = (i: BasketItemInput): BasketItemInput => {
    const existingCost = sourcedCosts.get(priceKey(i));
    if (existingCost !== undefined) return { ...i, unitCost: existingCost };
    if (i.productId) {
      const cat = addedProductCatalog.get(i.productId);
      if (!cat) throw new ConflictError(`"${i.label}" is not a known product.`);
      return { ...i, unitPrice: cat.price, unitCost: cat.cost };
    }
    return { ...i, unitCost: 0 };
  };
  // Computed once and reused for both the stored rows and the discount audit
  // line below, so the two can't ever disagree about what a new product line
  // actually costs.
  const correctedItems = input.items.map(withCatalogPriceAndCost);

  await db.$transaction(async (tx) => {
    await tx.visitBasketItem.deleteMany({ where: { basketId: id } });
    await tx.visitBasket.update({
      where: { id },
      data: {
        discountType: nextType,
        discountValue: nextValue,
        discountReason: nextReason,
        currency: input.currency ?? "USD",
        items: { create: correctedItems.map(itemCreate) },
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
        entityLabel: `${clientName} (client) · ${dietitianName} (doctor) — consultation fee ${auditMoney(fee?.unitPrice ?? 0, fee?.currency ?? "USD")} waived at settlement`,
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
        correctedItems.map((i) => ({
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
    // Each leg is a (method × currency × native amount). The USD value of a leg
    // is NEVER taken from the caller — it is derived here from the admin-set rate.
    splits?: { method: string; currency?: TenderCurrency; amount: number }[];
    // Rates the settlement screen displayed. Advisory only — see detectStaleRates.
    expectedRates?: Partial<Record<TenderCurrency, number>>;
    notes?: string;
    createdById?: string | null;
    actorName?: string | null;
    // Secretary override: the client couldn't cover everything today, so record
    // what's still owed as a tracked ClientDebt alongside the payment for what was
    // actually collected. Deferring the whole basket is allowed — that settles it,
    // and the sessions it bought unlock exactly as if it had been paid.
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
    // of a full payment (which would double-count the same money as both income
    // and owed). Every line is deferrable, session-plan lines included: a basket
    // is settled either by payment or by moving the balance to a ClientDebt, and
    // both settle it equally. That is the ONLY thing tracking the unpaid money —
    // the plan itself carries no balance owed, so the same $40 can never sit on a
    // plan and on a debt at once.
    const rate = row.usdToLbp > 0 ? row.usdToLbp : CLINIC.defaultUsdToLbp;
    const debtAmount = Math.max(0, input.debtAmount ?? 0);
    if (debtAmount > view.total) {
      throw new ConflictError(
        `The recorded debt can't exceed the $${view.total.toFixed(2)} owed on this basket.`,
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
    // The still-OUTSTANDING part of each debt (principal minus anything already
    // collected against it in an earlier partial payment) — never the raw
    // principal, which would collect money the patient no longer owes.
    const oldDebtUsd = round2(
      debtsToCollect.reduce(
        (s, d) =>
          s +
          Math.max(
            0,
            toUsd(d.amount, d.currency, d.usdToLbp > 0 ? d.usdToLbp : rate) - d.paidAmount,
          ),
        0,
      ),
    );

    // The single combined amount actually collected now (USD), across every method.
    const combinedCollected = Math.round((todayCollected + oldDebtUsd) * 100) / 100;

    // Resolve the FX rates ONCE, here, inside the transaction — from Settings,
    // never from the request. Every leg of this settlement is valued and frozen at
    // the same instant, so a rate edited mid-checkout cannot value two legs of one
    // bill differently, and a crafted request cannot supply its own rate.
    const rates = await getSettings();

    // Normalize the split: fold duplicates, drop zero/negative portions.
    //
    // The fold key is method × CURRENCY, not method alone. "Cash / USD $100" and
    // "Cash / EUR €200" are two economically distinct legs of one settlement;
    // folding them on method would silently destroy one native amount and
    // mis-state the drawer.
    type Leg = { method: string; currency: TenderCurrency; native: number; fxRate: number; usd: number };
    const byLeg = new Map<string, Leg>();
    for (const s of input.splits ?? []) {
      const currency: TenderCurrency = s.currency ?? "USD";
      const native = Math.max(0, round2(s.amount ?? 0));
      if (!(native > 0)) continue;
      // Throws (409) on an unusable rate — a leg that cannot be valued must not
      // be recorded, rather than silently valued 1:1 with the dollar.
      const fxRate = fxRateFor(currency, rates);
      const key = `${s.method}|${currency}`;
      const prev = byLeg.get(key);
      const merged = prev ? round2(prev.native + native) : native;
      byLeg.set(key, {
        method: s.method,
        currency,
        native: merged,
        fxRate,
        // Converted ONCE, from the merged native total, so folding two entries of
        // the same leg cannot round twice.
        usd: tenderToUsd(merged, currency, fxRate),
      });
    }
    const legs = [...byLeg.values()];

    // STALE-RATE GATE. If the admin edited a rate between this screen being
    // prepared and submitted, reject the whole settlement with a message naming
    // the real cause. Re-pricing silently would be worse than useless: the desk
    // would collect the foreign amount it was shown while the system booked a
    // different USD value, and the patient would walk away short. Checked before
    // any money is recorded, and only for currencies this settlement actually
    // uses — an LBP rate change must not block a USD+EUR payment.
    const stale = detectStaleRates(legs, input.expectedRates, rates);
    if (stale.length > 0) throw new StaleFxRateError(describeStaleRates(stale), rates, stale);

    const splitTotal = round2(legs.reduce((sum, l) => sum + l.usd, 0));

    // HARD validation (authoritative — mirrors the debt-cap check): the legs must
    // sum, in USD, to what's being collected. Blocks a settlement that doesn't add
    // up, so recorded income can never drift from the money actually taken.
    //
    // The tolerance is the app's original half-cent for a USD-only settlement —
    // unchanged, so no cent-level underpayment can slip through on the path
    // virtually every settlement takes — plus half a cent per CONVERTED leg, which
    // is exactly the rounding one conversion can introduce and no more. It is not
    // widened because LBP amounts are large; only the number of conversions matters.
    const tolerance = settlementToleranceUsd(legs);
    const drift = round2(splitTotal - combinedCollected);
    if (Math.abs(drift) > tolerance) {
      // Name the direction and the exact gap. "Must add up" alone left the desk
      // to work out whether they were over or under, and by how much — with
      // foreign legs on screen that is real mental arithmetic at the counter.
      const anyForeign = legs.some((l) => l.currency !== "USD");
      const equivalent = anyForeign ? " USD equivalent" : "";
      throw new ConflictError(
        drift > 0
          ? `That collects $${splitTotal.toFixed(2)}${equivalent} against $${combinedCollected.toFixed(2)} due — $${Math.abs(drift).toFixed(2)} too much. The clinic records no credit balances, so reduce a payment amount.`
          : `That collects $${splitTotal.toFixed(2)}${equivalent} against $${combinedCollected.toFixed(2)} due — $${Math.abs(drift).toFixed(2)} short. Increase a payment amount, or record the remainder as a debt.`,
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
    const multi = legs.length > 1;

    let paymentId: string | null = null;
    let primaryReceipt: string | null = null;
    for (const leg of legs) {
      const methodLabel = PAYMENT_METHOD_LABELS[leg.method as PaymentMethod] ?? leg.method;
      const motif = multi
        ? `${baseMotif} (${methodLabel}${leg.currency === "USD" ? "" : ` · ${leg.currency}`})`
        : baseMotif;
      const payment = await createPayment(
        {
          clientId: row.clientId,
          motif,
          // The pre-surcharge portion the secretary entered, in the leg's OWN
          // currency; createPayment adds the clinic's card fee on top when method
          // is "card" (natively, one rounding) and freezes this leg's FX rate.
          amountPaid: leg.native,
          currency: leg.currency,
          method: leg.method,
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

    // FREEZE THE DISCOUNT ALLOCATION. The bill-level discount was agreed on the
    // bill; from here on it must also be attributable, because revenue is reported
    // per line (a bundle sale, a product sale, a treatment) and every one of those
    // figures has to net down to what the client actually paid.
    //
    // The original `unitPrice` on each line is untouched — it stays the auditable
    // record of what the item costs. Only the share of the reduction is written,
    // and it is allocated proportionally with a largest-remainder rule so
    //
    //     Σ (unitPrice × quantity − discountAmount) === the basket total
    //
    // exactly, with no residual cent between the lines and the bill. Frozen here,
    // at settlement, so a later change to the discount rule can never restate what
    // was charged. Covered lines contribute nothing to the bill and absorb none of
    // the discount.
    if (view.discount > 0) {
      const shares = allocateDiscount(
        view.items.map((i) => ({
          gross: basketLineUsd(i, rate),
          covered: i.covered,
        })),
        view.discount,
      );
      for (let idx = 0; idx < view.items.length; idx++) {
        if (shares[idx] <= 0) continue;
        await tx.visitBasketItem.update({
          where: { id: view.items[idx].id },
          data: { discountAmount: shares[idx] },
        });
      }
    }

    // Inventory: deduct by the FINAL settled quantity of each product line —
    // `row.items` was read fresh at the top of this transaction, so it already
    // reflects any quantity edits the secretary saved before settling. This is
    // the only place stock is deducted for a sale (see adjustProductStockTx in
    // server/repositories/products.ts); the `flipped` guard above means this
    // runs at most once per basket, so a re-settle attempt can never deduct
    // twice. Net by productId first — the same product can appear as more than
    // one line (e.g. the dietitian's sent line plus one the secretary added).
    const soldByProduct = new Map<string, number>();
    for (const item of row.items) {
      if (item.productId) {
        soldByProduct.set(item.productId, (soldByProduct.get(item.productId) ?? 0) + item.quantity);
      }
    }
    if (soldByProduct.size > 0) {
      const clientName = `${row.client.firstName} ${row.client.lastName}`;
      for (const [productId, qty] of soldByProduct) {
        await adjustProductStockTx(tx, {
          productId,
          delta: -qty,
          type: "sale",
          context: `${clientName} — basket settled${primaryReceipt ? ` (receipt ${primaryReceipt})` : ""}`,
          actorName: input.actorName,
          actorUserId: input.createdById ?? null,
        });
      }
    }

    // UNLOCK. The FINAL settled quantity of each charged session line advances
    // that plan's sessionsPaid, which is what makes those sessions usable. This
    // sits AFTER the conditional pending->paid flip above, so a double submit
    // unlocks exactly once; and it commits in the same transaction as the payment
    // (or the debt below), so a basket settled either way unlocks identically.
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
      // Atomic increment, not read-then-write: two baskets settling against the
      // same plan at the same moment must both land, or one payment's sessions
      // would be silently lost.
      await creditSessionPlanPaidTx(tx, planId, qty);
    }

    // Secretary override: record the deferred (already subtracted from `collected`)
    // remainder as a tracked debt in the same transaction as the payment, linked to
    // this basket's visit. collected + debtAmount always equals today's total.
    if (debtAmount > 0) {
      await createClientDebtTx(tx, {
        clientId: row.clientId,
        consultationId: row.consultationId,
        // `debtAmount` is a USD figure — it is capped against `view.total`, which
        // basketTotals computes in USD. Stamping it with the BASKET's currency (as
        // this did) would file a $200 deferred balance as "200 LBP" (~$0.002) on
        // any LBP-priced basket. Obligations are USD, full stop.
        amount: debtAmount,
        currency: "USD",
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
        method: legs[0]?.method ?? "cash",
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
