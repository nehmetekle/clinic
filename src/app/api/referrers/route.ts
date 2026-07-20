import { createReferrer, listReferrers } from "@/server/repositories/referrers";
import { createReferrerSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Every signed-in role reads the list — it drives the referrer dropdown at
    // registration and check-in for the secretary and dietitian.
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    return json(await listReferrers());
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
