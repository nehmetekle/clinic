import { createPackage, listPackages } from "@/server/repositories/packages";
import { createPackageSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { withoutCost } from "@/server/serialize";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const rows = await listPackages();
    // `cost`/margin is owner-only; strip it for other roles that read the catalog.
    return json(role === "admin" ? rows : rows.map(withoutCost));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Only the admin creates packages and sets their price/cost.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createPackageSchema);
    return json(await createPackage(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
