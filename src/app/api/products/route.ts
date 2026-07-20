import { createProduct, listProducts } from "@/server/repositories/products";
import { createProductSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { withoutCost } from "@/server/serialize";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const rows = await listProducts();
    // `cost`/margin is owner-only; the secretary/dietitian read this catalog to
    // sell products, but must not receive the clinic's cost figures.
    return json(role === "admin" ? rows : rows.map(withoutCost));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Product catalog & pricing are admin-only; everyone can read.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createProductSchema);
    return json(await createProduct(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
