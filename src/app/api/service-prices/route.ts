import {
  createServicePrice,
  listServicePrices,
} from "@/server/repositories/service-prices";
import { createServicePriceSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { withoutCost } from "@/server/serialize";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const rows = await listServicePrices();
    // `cost`/margin is owner-only; the consultation form reads these for prices
    // but non-admin roles must not receive the clinic's cost figures.
    return json(role === "admin" ? rows : rows.map(withoutCost));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Only admins manage the treatment-type catalog; everyone else reads it.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createServicePriceSchema);
    return json(await createServicePrice(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
