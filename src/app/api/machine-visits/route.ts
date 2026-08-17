import { createMachineVisit, listMachineVisits } from "@/server/repositories/machineVisits";
import { createMachineVisitSchema } from "@/lib/validation";
import { actingRole, actingUser, canLogMachineVisit } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Readable by any signed-in role: a machine visit carries no clinical data
    // (a machine name, a session count, who recorded it), and the front desk needs
    // it on the client profile and the queue.
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const params = new URL(req.url).searchParams;
    // `scope=mine` narrows the list to visits this doctor personally recorded.
    // Only meaningful for a dietitian — an admin sees every doctor's, so the
    // flag is ignored for them.
    const actor = await actingUser(req);
    const recordedById =
      params.get("scope") === "mine" && actor.role === "dietitian" && actor.id
        ? actor.id
        : undefined;
    return json(
      await listMachineVisits({
        clientId: params.get("clientId") ?? undefined,
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        recordedById,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await canLogMachineVisit(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createMachineVisitSchema);
    const actor = await actingUser(req);
    // Actor identity comes from the verified session, never from the payload.
    return json(await createMachineVisit(input, actor), 201);
  } catch (e) {
    return handleError(e);
  }
}
