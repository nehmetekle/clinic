import { db } from "@/server/db";
import { adjustProductStockTx } from "@/server/repositories/products";
import { adjustProductStockSchema } from "@/lib/validation";
import { actingRole, actingUser } from "@/server/auth";
import { NotFoundError } from "@/server/http";
import { handleError, json, readJson } from "@/server/http";

// Admin-only, manual stock adjustments (restock / correction). Automatic
// sale-driven deduction happens server-side in the consultation save path
// (server/repositories/consultations.ts) — never through this route.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, adjustProductStockSchema);
    const actor = await actingUser(req);
    const product = await db.$transaction((tx) =>
      adjustProductStockTx(tx, {
        productId: id,
        delta: input.delta,
        type: input.type,
        reason: input.reason,
        actorName: actor.name,
        actorEmail: actor.email,
      }),
    );
    if (!product) throw new NotFoundError("Product not found");
    return json(product);
  } catch (e) {
    return handleError(e);
  }
}
