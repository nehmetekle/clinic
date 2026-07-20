import {
  createConsultation,
  listConsultations,
} from "@/server/repositories/consultations";
import { createConsultationSchema } from "@/lib/validation";
import { actingUser, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Consultations are clinical records — the secretary has no access.
    if (!(await canViewClinical(req))) return json([]);
    const params = new URL(req.url).searchParams;
    const clientId = params.get("clientId") ?? undefined;
    // Only the two real statuses are honoured; anything else is ignored (no filter).
    const statusParam = params.get("status");
    const status = statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
    const date = params.get("date") ?? undefined;
    return json(await listConsultations({ clientId, status, date }));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { close, ...input } = await readJson(req, createConsultationSchema);
    const actor = (await actingUser(req));
    return json(
      await createConsultation(input, { close, actorName: actor.name, actorEmail: actor.email }),
      201,
    );
  } catch (e) {
    return handleError(e);
  }
}
