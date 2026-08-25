import { Prisma, type Product as ProductRow } from "@prisma/client";
import { db } from "../db";
import { toProduct } from "../serialize";
import { NotFoundError } from "../http";
import { writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { Product } from "@/lib/types";
import type { CreateProductInput, UpdateProductInput } from "@/lib/validation";

/** Active products first, then alphabetical — used by the visit product picker. */
export async function listProducts(): Promise<Product[]> {
  const rows = await db.product.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return rows.map(toProduct);
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  const row = await db.product.create({
    data: {
      name: input.name,
      price: input.price,
      cost: input.cost ?? 0,
      currency: input.currency ?? "USD",
      active: input.active ?? true,
      stock: input.stock ?? 0,
      lowStockThreshold: input.lowStockThreshold ?? 5,
    },
  });
  return toProduct(row);
}

export async function updateProduct(id: string, input: UpdateProductInput): Promise<Product> {
  const existing = await db.product.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Product not found");
  const row = await db.product.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      price: input.price ?? undefined,
      cost: input.cost ?? undefined,
      currency: input.currency ?? undefined,
      active: input.active ?? undefined,
      lowStockThreshold: input.lowStockThreshold ?? undefined,
    },
  });
  return toProduct(row);
}

export async function deleteProduct(id: string): Promise<void> {
  const existing = await db.product.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Product not found");
  await db.product.delete({ where: { id } });
}

type StockAdjustmentType = "sale" | "restock" | "correction";

/**
 * The single choke point for every stock change — `Product.stock` is never
 * written anywhere else. `delta` is signed (negative = leaves inventory,
 * positive = returns to it); stock is allowed to go negative (oversold) by
 * design, never blocked here. Every call writes one AuditLog row, so the log
 * is the complete history of how the current count was reached. Returns null
 * (a silent no-op) when the catalog product no longer exists — a sale line
 * whose product was deleted from the catalog meanwhile must not fail the
 * consultation save over an inventory count that has nothing left to track.
 * Runs in the caller's transaction so it commits/rolls back atomically with
 * the sale, restock, or correction that triggered it.
 */
export async function adjustProductStockTx(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    delta: number;
    type: StockAdjustmentType;
    reason?: string | null;
    // Extra human-readable context appended to the audit label, e.g. "Visit #12 — Jane Doe".
    context?: string | null;
    actorName?: string | null;
    actorEmail?: string | null;
    // When the caller already has a resolved user id (e.g. settlement, which
    // resolves it once up front), pass it here to skip the email lookup below.
    // Takes precedence over actorEmail when provided (including explicit null).
    actorUserId?: string | null;
  },
): Promise<Product | null> {
  const { delta, type } = params;
  if (delta === 0) return null;

  // A single guarded UPDATE — the database computes the new stock from the
  // row's own current value in one statement, so two concurrent adjustments
  // (e.g. two desks settling different baskets that both sell this product at
  // nearly the same moment) can't both read the same starting count and
  // silently overwrite each other's decrement — the classic lost-update race
  // under Postgres's default Read Committed isolation. Stock is allowed to go
  // negative (oversold) by design (see the schema comment), so there's no
  // WHERE-clause guard on the resulting value — only on the atomicity of the
  // read-and-increment itself. Mirrors the guarded-update pattern in
  // sessionCounters.ts.
  const rows = await tx.$queryRaw<ProductRow[]>`
    UPDATE "Product"
       SET "stock" = "stock" + ${delta}, "updatedAt" = NOW()
     WHERE "id" = ${params.productId}
     RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  const newStock = row.stock;

  const action =
    type === "sale"
      ? delta < 0
        ? "Product sold"
        : "Product sale reversed"
      : type === "restock"
        ? "Product restocked"
        : "Stock corrected";
  const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
  const suffix = type === "sale" ? params.context : params.reason || "no reason given";
  const entityLabel = `${row.name} ${deltaStr} → stock ${newStock}${suffix ? ` — ${suffix}` : ""}`;

  const userId =
    params.actorUserId !== undefined ? params.actorUserId : await userIdByEmail(params.actorEmail ?? undefined);
  await writeAudit(tx, {
    userId,
    userName: params.actorName,
    action,
    entityType: "Product",
    entityLabel,
  });

  return toProduct(row);
}
