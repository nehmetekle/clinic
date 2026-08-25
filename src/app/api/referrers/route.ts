import { createReferrer, listReferrers } from "@/server/repositories/referrers";
import { createReferrerSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { withoutFee } from "@/server/serialize";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Every signed-in role reads the list — it drives the referrer dropdown at
    // registration and check-in for the secretary and dietitian. `fee` (the
    // admin-set commission rate) is business-sensitive like every other cost
    // figure — same admin-only treatment as products/packages/service-prices.
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const rows = await listReferrers();
    return json(role === "admin" ? rows : rows.map(withoutFee));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Editing the referrer list is admin-only.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createReferrerSchema);
    return json(await createReferrer(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
