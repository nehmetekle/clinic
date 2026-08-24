import { Prisma } from "@prisma/client";
import { ConflictError, ForbiddenError } from "../http";
import { auditMoney, writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { BasketItemInput } from "./visitBaskets";

export type ConsultationBotoxLineInput = {
  id?: string;
  // Optional: required to resolve/create a NEW or still-unpaid line (checked
  // below, where the paid/unpaid split is known); absent is only tolerated for
  // a PAID line resent unchanged, whose catalog item may since have been
  // hard-deleted (nulling this on the row — see the model comment).
  botoxItemId?: string;
  quantity?: number;
  chargedPrice: number;
  notes?: string;
};

/**
 * Rebuilds this visit's Botox lines from the submitted state.
 *
 * Unlike treatments/products (deleted and fully rebuilt on every draft save),
 * a Botox line is doctor-priced per visit rather than fixed from the catalog,
 * so the generic price-in-signature basket netting (`remainingUnpaidItems` in
 * visitBaskets.ts) can't safely protect it — a price edit on an already-paid
 * line would present as a brand-new, unpaid line and get charged again. This
 * function is the guard instead:
 *
 *   - A line with ANY paid basket coverage (a `VisitBasketItem` referencing it
 *     sitting in a `paid` VisitBasket) must come back byte-for-byte —
 *     `botoxItemId`, `chargedPrice`, `quantity`, `notes` all unchanged, and it
 *     cannot be dropped from the input. This app has no refund/reversal
 *     concept, so a charge already collected can never move again.
 *   - An unpaid line is a normal upsert: `update` when `id` matches an
 *     existing unpaid row (so the id — and any paid-lock decided on a LATER
 *     save — stays stable), `create` when `id` is absent. An unpaid row whose
 *     id is missing from the input was removed by the doctor and is deleted.
 *   - An `id` that matches neither a paid nor an unpaid row on THIS
 *     consultation is refused outright (a foreign/tampered reference).
 *
 * Returns the basket lines for whatever is still unpaid — a paid line
 * contributes nothing new to charge, so it's excluded entirely (the money was
 * already recorded when it was settled).
 *
 * `actorCanOfferBotox` gates the whole operation. The primary gate is the
 * route's `canOfferBotox(req)` check (and the consultation editor never even
 * renders the section to an unauthorized user) — this is defense in depth so
 * a direct API call can't bypass it.
 */
export async function buildBotoxLinesTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
  lines: ConsultationBotoxLineInput[],
  opts: {
    actorCanOfferBotox: boolean;
    actor?: { name?: string | null; email?: string | null };
    visitNumber: number;
  },
): Promise<BasketItemInput[]> {
  if (!opts.actorCanOfferBotox) {
    throw new ForbiddenError("You're not authorized to add or change Botox charges on this visit.");
  }

  const existingRows = await tx.consultationBotoxItem.findMany({
    where: { consultationId },
    include: { basketItems: { include: { basket: { select: { status: true } } } } },
  });
  const isPaid = (row: (typeof existingRows)[number]) =>
    row.basketItems.some((bi) => bi.basket.status === "paid");
  const paidRowById = new Map(existingRows.filter(isPaid).map((r) => [r.id, r]));
  const unpaidRowById = new Map(existingRows.filter((r) => !isPaid(r)).map((r) => [r.id, r]));

  // PAID-LINE LOCK: every already-paid line must come back unchanged.
  for (const [id, row] of paidRowById) {
    const match = lines.find((l) => l.id === id);
    if (!match) {
      throw new ConflictError(
        `"${row.name}" has already been settled and can't be removed from this visit.`,
      );
    }
    const quantity = Math.max(1, Math.floor(match.quantity ?? 1));
    const notes = match.notes?.trim() || null;
    // NOTE: `botoxItemId` is deliberately NOT compared here. It can legitimately
    // go null on its own — a catalog item is hard-deletable (mirrors Product),
    // and the FK is ON DELETE SET NULL — with no attempt to touch this line at
    // all. What must not move is the actual charge: price, quantity and notes,
    // which stay on the row regardless of what happens to the catalog pointer.
    if (
      match.chargedPrice !== row.chargedPrice ||
      quantity !== row.quantity ||
      notes !== row.notes
    ) {
      throw new ConflictError(
        `"${row.name}" has already been settled and can't be changed. Add a new line instead if more is needed.`,
      );
    }
  }

  const newOrUpdated = lines.filter((l) => !l.id || !paidRowById.has(l.id));
  for (const l of newOrUpdated) {
    if (l.id && !unpaidRowById.has(l.id)) {
      throw new ConflictError("This Botox line no longer belongs to this visit.");
    }
  }

  const catalogIds = [
    ...new Set(newOrUpdated.map((l) => l.botoxItemId).filter((id): id is string => Boolean(id))),
  ];
  const catalogRows = catalogIds.length
    ? await tx.botoxItem.findMany({ where: { id: { in: catalogIds } } })
    : [];
  const catalogById = new Map(catalogRows.map((c) => [c.id, c]));

  // The doctor removed a previously-unpaid line — safe, nothing collected yet.
  // (A removed PAID line was already refused above.)
  const keepUnpaidIds = new Set(newOrUpdated.filter((l) => l.id).map((l) => l.id as string));
  const toDelete = [...unpaidRowById.keys()].filter((id) => !keepUnpaidIds.has(id));
  if (toDelete.length > 0) {
    await tx.consultationBotoxItem.deleteMany({ where: { id: { in: toDelete } } });
  }

  const actorUserId = await userIdByEmail(opts.actor?.email ?? undefined);
  const unpaidBasketItems: BasketItemInput[] = [];

  for (const l of newOrUpdated) {
    if (!l.botoxItemId) throw new ConflictError("A Botox item is required.");
    const cat = catalogById.get(l.botoxItemId);
    if (!cat) throw new ConflictError("Unknown Botox item.");
    const quantity = Math.max(1, Math.floor(l.quantity ?? 1));
    const chargedPrice = l.chargedPrice;
    const notes = l.notes?.trim() || null;
    const priorUnpaid = l.id ? unpaidRowById.get(l.id) : undefined;
    const data = {
      consultationId,
      botoxItemId: cat.id,
      // Frozen at the moment of this save: `name`/`basePrice` are the catalog's
      // CURRENT values (kept only for reference/audit, re-derived every save
      // while unpaid); `chargedPrice` is the doctor's own decision and the sole
      // authority for the basket/payment/history.
      name: cat.name,
      basePrice: cat.price,
      chargedPrice,
      quantity,
      currency: "USD",
      unitCost: cat.cost,
      notes,
    };
    let rowId: string;
    if (l.id) {
      await tx.consultationBotoxItem.update({ where: { id: l.id }, data });
      rowId = l.id;
    } else {
      const created = await tx.consultationBotoxItem.create({ data });
      rowId = created.id;
    }

    // Audit whenever the DOCTOR changes what's charged — a brand-new line
    // priced away from the catalog default, or an existing line's charged
    // price moving from what it was on this visit's last save. Catalog drift
    // alone (an admin editing the base price) never triggers this — only a
    // change to what THIS visit actually charges.
    const priceChanged = priorUnpaid
      ? chargedPrice !== priorUnpaid.chargedPrice
      : chargedPrice !== cat.price;
    if (priceChanged) {
      await writeAudit(tx, {
        userId: actorUserId,
        userName: opts.actor?.name,
        action: "Botox price overridden",
        entityType: "Consultation",
        entityLabel: `Visit #${opts.visitNumber} — ${cat.name} — base ${auditMoney(cat.price, "USD")} → charged ${auditMoney(chargedPrice, "USD")}`,
      });
    }

    unpaidBasketItems.push({
      kind: "botox",
      label: cat.name,
      detail: notes ?? undefined,
      quantity,
      unitPrice: chargedPrice,
      unitCost: cat.cost,
      currency: "USD",
      covered: false,
      consultationBotoxItemId: rowId,
    });
  }

  return unpaidBasketItems;
}

/**
 * The basket contribution of this consultation's already-unpaid Botox lines,
 * read straight off the rows — no validation, no upsert, no audit. Used when a
 * save omits `botoxItems` entirely (an untouched section — see
 * ConsultationInput.botoxItems): `buildConsultationContentTx` still rebuilds
 * the WHOLE pending basket from scratch on every save, so without this an
 * unrelated save by anyone (authorized or not) would silently drop an
 * already-added, still-unpaid Botox charge from what the secretary sees, even
 * though the ConsultationBotoxItem row itself is correctly left alone.
 */
export async function unpaidBotoxBasketItemsTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
): Promise<BasketItemInput[]> {
  const rows = await tx.consultationBotoxItem.findMany({
    where: { consultationId },
    include: { basketItems: { include: { basket: { select: { status: true } } } } },
  });
  return rows
    .filter((row) => !row.basketItems.some((bi) => bi.basket.status === "paid"))
    .map((row) => ({
      kind: "botox",
      label: row.name,
      detail: row.notes ?? undefined,
      quantity: row.quantity,
      unitPrice: row.chargedPrice,
      unitCost: row.unitCost,
      currency: "USD",
      covered: false,
      consultationBotoxItemId: row.id,
    }));
}
