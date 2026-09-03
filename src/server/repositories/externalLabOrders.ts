import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError } from "../http";
import { auditMoney, writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { BasketItemInput } from "./visitBaskets";
import type { ConsultationExternalLabOrder } from "@/lib/types";

/**
 * EXTERNAL LAB BLOOD COLLECTION — the order that carries its own price.
 *
 * The in-clinic blood tests next to this are catalog-priced: the doctor ticks
 * "CBC" and the server snapshots $20 from `ServicePrice`. An external lab does
 * not work that way. Staff phone the lab with a list of tests, the lab quotes
 * ONE number for the whole group, and that number is different next week for the
 * same two tests. So:
 *
 *   - the money is on the ORDER (`totalCostPrice`, `totalSalePrice`), and
 *   - the test lines underneath carry a name and free text and NO price.
 *
 * Resist the pull to put an amount on a test line. There is no per-test price to
 * put there; inventing one would create a second total that can disagree with
 * the one the lab actually charged.
 *
 * THREE ROLES, THREE DIFFERENT RIGHTS (see src/server/auth.ts):
 *
 *   dietitian / admin  create the order, edit the test list, set the COST, set
 *                      the sale price, and see the margin.
 *   secretary          sets the SALE price only, and never receives the cost —
 *                      not hidden in the UI, omitted from the payload
 *                      (`toExternalLabOrder`).
 *
 * FREEZING. Once the basket carrying this order is paid, nothing on the order
 * moves again — not the totals, not the test list, not by any role. This app has
 * no refund or reversal concept anywhere (CLAUDE.md, "No refunds"), so a charge
 * that has been collected can never be re-described. That is enforced here, in
 * the database's own CHECK constraints, and again by the basket's existing
 * price-protection at checkout.
 */

export type ExternalLabTestInput = {
  name: string;
  description?: string;
};

export type ExternalLabOrderInput = {
  /** Omitted by a caller who may not set it (secretary): the stored cost is kept
   * as-is rather than being reset to 0 by someone who cannot see it. */
  totalCostPrice?: number;
  totalSalePrice: number;
  belowCostReason?: string;
  notes?: string;
  tests: ExternalLabTestInput[];
};

/** Ceiling on how many tests one order may list. Not a business rule the clinic
 * asked for — a bound, so a malformed or hostile payload can't write ten
 * thousand rows against one visit. Comfortably above any real lab panel. */
const MAX_TESTS_PER_ORDER = 50;
/** Absolute ceiling on either total. A lab bill four orders of magnitude past the
 * clinic's biggest real one is a typo or an attack, not a quote. */
const MAX_ORDER_AMOUNT = 1_000_000;

const orderInclude = {
  tests: { orderBy: { position: "asc" } },
  basketItems: { include: { basket: { select: { status: true } } } },
} satisfies Prisma.ConsultationExternalLabOrderInclude;

type OrderRow = Prisma.ConsultationExternalLabOrderGetPayload<{ include: typeof orderInclude }>;

/**
 * An order is settled once ANY basket line billing it sits in a SETTLED basket.
 *
 * BOTH settled statuses, never `paid` alone. `closed` is not a different kind of
 * sale — it is the same settled basket after `retirePaidBasketsTx` retired it
 * from the settlement queue when the visit closed. Testing `paid` only would
 * un-freeze every order the moment its visit closed, which is precisely when it
 * is most finished: the money is collected and the visit is read-only. (The
 * consultation editor would still refuse — a closed visit can't be saved — but
 * the front desk's reprice route has no such backstop, and would happily rewrite
 * the price of a charge the clinic already collected.)
 *
 * This is the same rule `basketWhere` in repositories/profitability.ts applies
 * for the same reason.
 */
export function isOrderSettled(row: OrderRow): boolean {
  return row.basketItems.some((bi) => bi.basket.status === "paid" || bi.basket.status === "closed");
}

/**
 * Row → API shape, with the cost redacted for readers who may not see it.
 *
 * `canSeeCost` is the caller's already-resolved permission, never re-derived
 * here: this function has no Request and must not guess. When it is false the
 * cost fields are ABSENT from the object rather than zeroed or nulled — a
 * secretary's browser never receives the number at all, so no UI mistake, no
 * React devtools inspection and no cached response can leak it.
 */
export function toExternalLabOrder(
  row: OrderRow,
  opts: { canSeeCost: boolean },
): ConsultationExternalLabOrder {
  return {
    id: row.id,
    currency: "USD",
    ...(opts.canSeeCost
      ? {
          totalCostPrice: row.totalCostPrice,
          belowCostReason: row.belowCostReason ?? undefined,
        }
      : {}),
    canSeeCost: opts.canSeeCost,
    totalSalePrice: row.totalSalePrice,
    notes: row.notes ?? undefined,
    tests: row.tests.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? undefined,
    })),
    pricedByName: row.pricedByName ?? undefined,
    pricedAt: row.pricedAt?.toISOString(),
    settled: isOrderSettled(row),
  };
}

export async function getExternalLabOrder(
  consultationId: string,
  opts: { canSeeCost: boolean },
): Promise<ConsultationExternalLabOrder | null> {
  const row = await db.consultationExternalLabOrder.findUnique({
    where: { consultationId },
    include: orderInclude,
  });
  return row ? toExternalLabOrder(row, opts) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validates one money figure the same way for cost and sale price. Rejects NaN
 * and Infinity explicitly — both survive a bare `>= 0` test. */
function money(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new ConflictError(`${label} must be a number.`);
  if (value < 0) throw new ConflictError(`${label} can't be negative.`);
  if (value > MAX_ORDER_AMOUNT) {
    throw new ConflictError(`${label} looks wrong — it exceeds the maximum allowed amount.`);
  }
  return round2(value);
}

function cleanTests(tests: ExternalLabTestInput[]): { name: string; description: string | null }[] {
  const cleaned = tests
    .map((t) => ({
      name: t.name?.trim() ?? "",
      description: t.description?.trim() || null,
    }))
    .filter((t) => t.name.length > 0);
  if (cleaned.length === 0) {
    throw new ConflictError("List at least one test in the external lab order.");
  }
  if (cleaned.length > MAX_TESTS_PER_ORDER) {
    throw new ConflictError(`An external lab order can list at most ${MAX_TESTS_PER_ORDER} tests.`);
  }
  return cleaned;
}

/** The basket line an order bills: ONE line for the whole outsourced order,
 * priced at the sale total, costed at what the lab charges us. Quantity is
 * always 1 — the order is the unit, not the test. */
function basketLineFor(row: {
  id: string;
  totalSalePrice: number;
  totalCostPrice: number;
  tests: { name: string }[];
}): BasketItemInput {
  const names = row.tests.map((t) => t.name);
  // The detail line is what the secretary and the receipt show. Truncated so a
  // 50-test order can't produce an unreadable basket row.
  const shown = names.slice(0, 6).join(", ");
  const detail =
    names.length > 6 ? `${shown} +${names.length - 6} more` : shown || "External lab";
  return {
    kind: "external_lab",
    label: "External lab blood collection",
    detail,
    quantity: 1,
    unitPrice: row.totalSalePrice,
    unitCost: row.totalCostPrice,
    currency: "USD",
    covered: false,
    externalLabOrderId: row.id,
  };
}

/** Signature of everything a settled order is forbidden to change. */
function orderFingerprint(o: {
  totalCostPrice: number;
  totalSalePrice: number;
  tests: { name: string; description: string | null }[];
}): string {
  return [
    o.totalCostPrice,
    o.totalSalePrice,
    o.tests.map((t) => `${t.name} ${t.description ?? ""}`).join(""),
  ].join("::");
}

/**
 * Rebuilds this visit's external-lab order from the submitted state and returns
 * the basket line it should be billed at (empty when there is no order).
 *
 * `input === null` means the doctor removed the order from the visit. Allowed
 * only while nothing has been collected.
 *
 * `input === undefined` never reaches here: an absent key means the section was
 * untouched, and the caller uses `unpaidExternalLabBasketItemsTx` instead — the
 * same "absent = don't touch" rule Botox and the Food List already follow, and
 * for the same reason (the consultation save rebuilds the WHOLE pending basket,
 * so a save that omits the section must still re-contribute its charge or an
 * unrelated save would silently drop it from what the patient owes).
 */
export async function buildExternalLabOrderTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
  input: ExternalLabOrderInput | null,
  opts: {
    /** Route-level `canOrderExternalLab`. Re-checked here as defense in depth. */
    actorCanOrder: boolean;
    /** Route-level `canViewExternalLabCost` — whether `totalCostPrice` in the
     * input may be honoured at all. */
    actorCanSetCost: boolean;
    actor?: { name?: string | null; email?: string | null };
    visitNumber: number;
  },
): Promise<BasketItemInput[]> {
  const existing = await tx.consultationExternalLabOrder.findUnique({
    where: { consultationId },
    include: orderInclude,
  });

  // Nothing there and nothing asked for: the common case, no work, no audit.
  if (!existing && !input) return [];

  if (!opts.actorCanOrder) {
    throw new ForbiddenError(
      "You're not authorized to add or change the external lab order on this visit.",
    );
  }

  const settled = existing ? isOrderSettled(existing) : false;

  if (settled) {
    // FROZEN. A settled order must come back byte-for-byte, and cannot be
    // dropped. There is no refund path in this app, so money already collected
    // can never be re-described.
    if (!input) {
      throw new ConflictError(
        "This external lab order has already been settled and can't be removed from the visit.",
      );
    }
    const incomingCost = opts.actorCanSetCost
      ? money(input.totalCostPrice ?? 0, "External lab cost")
      : existing!.totalCostPrice;
    const before = orderFingerprint({
      totalCostPrice: existing!.totalCostPrice,
      totalSalePrice: existing!.totalSalePrice,
      tests: existing!.tests.map((t) => ({ name: t.name, description: t.description })),
    });
    const after = orderFingerprint({
      totalCostPrice: incomingCost,
      totalSalePrice: money(input.totalSalePrice, "External lab sale price"),
      tests: cleanTests(input.tests),
    });
    if (before !== after) {
      throw new ConflictError(
        "This external lab order has already been settled and can't be changed.",
      );
    }
    // Unchanged and already paid: it contributes nothing new to charge.
    return [];
  }

  const actorUserId = await userIdByEmail(opts.actor?.email ?? undefined);

  if (!input) {
    await tx.consultationExternalLabOrder.delete({ where: { id: existing!.id } });
    await writeAudit(tx, {
      userId: actorUserId,
      userName: opts.actor?.name,
      action: "External lab order removed",
      entityType: "Consultation",
      entityLabel: `Visit #${opts.visitNumber} — external lab order for ${auditMoney(existing!.totalSalePrice, "USD")} removed before settlement`,
    });
    return [];
  }

  const tests = cleanTests(input.tests);
  const totalSalePrice = money(input.totalSalePrice, "External lab sale price");
  // A caller who may not set the cost (never reaches here today — the route gate
  // is stricter — but the rule belongs with the write, not with the route) keeps
  // whatever cost is already stored rather than blanking it to 0 and silently
  // reporting the order as pure profit.
  const totalCostPrice = opts.actorCanSetCost
    ? money(input.totalCostPrice ?? 0, "External lab cost")
    : (existing?.totalCostPrice ?? 0);

  // BELOW COST. Selling for less than the lab charges is permitted — the clinic
  // sometimes absorbs a difference — but never anonymously: someone has to write
  // down why. Enforced here, and again by a CHECK constraint in the migration so
  // the state is unrepresentable however the row is written.
  const belowCost = totalSalePrice < totalCostPrice;
  const belowCostReason = input.belowCostReason?.trim() || null;
  if (belowCost && !belowCostReason) {
    throw new ConflictError(
      "The sale price is below what the lab charges us. Enter a reason to save it at this price.",
    );
  }

  const data = {
    consultationId,
    currency: "USD",
    totalCostPrice,
    totalSalePrice,
    // Cleared once the order is no longer below cost: a justification that no
    // longer applies must not sit on the record looking like it does.
    belowCostReason: belowCost ? belowCostReason : null,
    notes: input.notes?.trim() || null,
    pricedByName: opts.actor?.name ?? null,
    pricedAt: new Date(),
  };

  let orderId: string;
  if (existing) {
    await tx.consultationExternalLabOrder.update({ where: { id: existing.id }, data });
    orderId = existing.id;
    // Test lines are small and fully re-sent every save: replace rather than
    // diff. Nothing downstream references a test row by id.
    await tx.consultationExternalLabTest.deleteMany({ where: { orderId } });
  } else {
    const created = await tx.consultationExternalLabOrder.create({ data });
    orderId = created.id;
  }
  await tx.consultationExternalLabTest.createMany({
    data: tests.map((t, index) => ({
      orderId,
      name: t.name,
      description: t.description,
      position: index,
    })),
  });

  // AUDIT. Every figure that moved, with its old value, plus who and when. A
  // freely-typed price with no history is exactly the manipulation risk this
  // feature carries, so the trail is written inside the same transaction as the
  // change — it commits with it or not at all.
  const costMoved = !existing || existing.totalCostPrice !== totalCostPrice;
  const saleMoved = !existing || existing.totalSalePrice !== totalSalePrice;
  if (!existing) {
    await writeAudit(tx, {
      userId: actorUserId,
      userName: opts.actor?.name,
      action: "External lab order created",
      entityType: "Consultation",
      entityLabel:
        `Visit #${opts.visitNumber} — ${tests.length} test(s): ${tests.map((t) => t.name).join(", ")} — ` +
        `cost ${auditMoney(totalCostPrice, "USD")}, sale ${auditMoney(totalSalePrice, "USD")}`,
    });
  } else if (costMoved || saleMoved) {
    const parts: string[] = [];
    if (costMoved) {
      parts.push(
        `cost ${auditMoney(existing.totalCostPrice, "USD")} → ${auditMoney(totalCostPrice, "USD")}`,
      );
    }
    if (saleMoved) {
      parts.push(
        `sale ${auditMoney(existing.totalSalePrice, "USD")} → ${auditMoney(totalSalePrice, "USD")}`,
      );
    }
    await writeAudit(tx, {
      userId: actorUserId,
      userName: opts.actor?.name,
      action: "External lab order repriced",
      entityType: "Consultation",
      entityLabel: `Visit #${opts.visitNumber} — ${parts.join(", ")}`,
    });
  }
  // Selling below cost is its own audit line, separate from the reprice, so it
  // can be found without reading every price change ever made.
  if (belowCost && (!existing || existing.totalSalePrice !== totalSalePrice || existing.totalCostPrice !== totalCostPrice)) {
    await writeAudit(tx, {
      userId: actorUserId,
      userName: opts.actor?.name,
      action: "External lab order priced below cost",
      entityType: "Consultation",
      entityLabel:
        `Visit #${opts.visitNumber} — sale ${auditMoney(totalSalePrice, "USD")} below cost ` +
        `${auditMoney(totalCostPrice, "USD")} — reason: ${belowCostReason}`,
    });
  }

  return [basketLineFor({ id: orderId, totalSalePrice, totalCostPrice, tests })];
}

/**
 * The basket contribution of this visit's existing, still-unsettled external-lab
 * order — read straight off the row, with no validation, no write and no audit.
 *
 * Used when a consultation save omits `externalLabOrder` entirely (an untouched
 * section). Without this, an unrelated save would rebuild the pending basket
 * without the order's charge and quietly reduce what the patient owes, even
 * though the order row itself was correctly left alone.
 */
export async function unpaidExternalLabBasketItemsTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
): Promise<BasketItemInput[]> {
  const row = await tx.consultationExternalLabOrder.findUnique({
    where: { consultationId },
    include: orderInclude,
  });
  if (!row || isOrderSettled(row)) return [];
  return [
    basketLineFor({
      id: row.id,
      totalSalePrice: row.totalSalePrice,
      totalCostPrice: row.totalCostPrice,
      tests: row.tests,
    }),
  ];
}

/**
 * The FRONT DESK's edit: change what the patient is charged, and nothing else.
 *
 * This exists as its own entry point rather than as a relaxation of the basket's
 * price protection. A basket line's price must always equal the price its source
 * gave it — that invariant is what makes the bill auditable — so the secretary
 * edits the SOURCE (this order) and the line is re-derived from it, instead of
 * retyping the line at checkout and leaving the order disagreeing with the bill.
 *
 * The caller must already have checked `canPriceExternalLabSale`. The cost is
 * neither read from nor written by this function, and is never returned to a
 * caller who may not see it.
 */
export async function setExternalLabSalePrice(
  consultationId: string,
  input: { totalSalePrice: number; belowCostReason?: string },
  actor: { name?: string | null; email?: string | null; role?: string | null },
  opts: { canSeeCost: boolean },
): Promise<ConsultationExternalLabOrder> {
  const totalSalePrice = money(input.totalSalePrice, "External lab sale price");
  return db.$transaction(async (tx) => {
    const existing = await tx.consultationExternalLabOrder.findUnique({
      where: { consultationId },
      include: { ...orderInclude, consultation: { select: { visitNumber: true, status: true } } },
    });
    if (!existing) throw new NotFoundError("No external lab order on this visit.");
    if (isOrderSettled(existing)) {
      throw new ConflictError(
        "This external lab order has already been settled and can't be repriced.",
      );
    }

    const belowCost = totalSalePrice < existing.totalCostPrice;
    const belowCostReason = input.belowCostReason?.trim() || null;
    if (belowCost && !belowCostReason) {
      // NOTE: this message deliberately does NOT state the cost. A secretary who
      // may not see the cost still learns from the refusal that the price they
      // typed is below it — a one-bit leak that repeated probing could narrow
      // into the actual figure. It is accepted knowingly: the alternative is
      // letting the front desk sell below cost with nothing on record, which is
      // the larger of the two risks. Documented in docs/known-issues.md §19.
      throw new ConflictError(
        "That price is below what this order costs the clinic. Enter a reason to save it.",
      );
    }

    await tx.consultationExternalLabOrder.update({
      where: { id: existing.id },
      data: {
        totalSalePrice,
        belowCostReason: belowCost ? belowCostReason : null,
        pricedByName: actor.name ?? null,
        pricedAt: new Date(),
      },
    });

    // Re-derive the pending basket line from the new source price. Only PENDING
    // lines: a paid one was refused above, and a `closed` basket is history.
    const pendingLineIds = existing.basketItems
      .filter((bi) => bi.basket.status === "pending")
      .map((bi) => bi.id);
    if (pendingLineIds.length > 0) {
      await tx.visitBasketItem.updateMany({
        where: { id: { in: pendingLineIds } },
        data: { unitPrice: totalSalePrice },
      });
    }

    if (existing.totalSalePrice !== totalSalePrice) {
      await writeAudit(tx, {
        userId: await userIdByEmail(actor.email ?? undefined),
        userName: actor.name,
        action: "External lab sale price changed",
        entityType: "Consultation",
        entityLabel:
          `Visit #${existing.consultation.visitNumber} — sale ` +
          `${auditMoney(existing.totalSalePrice, "USD")} → ${auditMoney(totalSalePrice, "USD")}` +
          (belowCost ? ` (below cost — reason: ${belowCostReason})` : "") +
          ` — by ${actor.role ?? "unknown role"}`,
      });
    }

    const fresh = await tx.consultationExternalLabOrder.findUniqueOrThrow({
      where: { id: existing.id },
      include: orderInclude,
    });
    return toExternalLabOrder(fresh, opts);
  });
}
