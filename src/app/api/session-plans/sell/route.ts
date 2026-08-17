import { sellSessions } from "@/server/repositories/sessionPlans";
import { sellSessionsSchema } from "@/lib/validation";
import { actingUser, canSellSessions } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

/**
 * Sells (or tops up) treatment sessions without opening a consultation. Creates
 * the pending basket only — settling it is what unlocks the sessions.
 */
export async function POST(req: Request) {
  try {
    if (!(await canSellSessions(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, sellSessionsSchema);
    const actor = await actingUser(req);
    return json(await sellSessions(input, { id: actor.id, name: actor.name }), 201);
  } catch (e) {
    return handleError(e);
  }
}
