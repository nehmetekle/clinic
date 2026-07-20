import { db } from "../db";
import { toProduct } from "../serialize";
import { NotFoundError } from "../http";
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
    },
  });
  return toProduct(row);
}

export async function deleteProduct(id: string): Promise<void> {
  const existing = await db.product.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Product not found");
  await db.product.delete({ where: { id } });
}
