import {
  createConsultation,
  listConsultations,
} from "@/server/repositories/consultations";
import { createConsultationSchema } from "@/lib/validation";
import { ensureFoodListPdf } from "@/server/services/foodListPdf";
import {
  actingUser,
  canOfferBotox,
  canOrderExternalLab,
  canViewClinical,
  canViewExternalLabCost,
} from "@/server/auth";
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
    // `scope=mine` narrows the list to the caller's own visits. Only meaningful
    // for a dietitian — an admin oversees every doctor's visits, so the flag is
    // ignored for them.
    const actor = await actingUser(req);
    const dietitianId =
      params.get("scope") === "mine" && actor.role === "dietitian" && actor.id
        ? actor.id
        : undefined;
    return json(await listConsultations({ clientId, status, date, dietitianId }));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { close, ...input } = await readJson(req, createConsultationSchema);
    const actor = (await actingUser(req));
    const created = await createConsultation(input, {
      close,
      actorName: actor.name,
      actorEmail: actor.email,
      actorCanOfferBotox: await canOfferBotox(req),
      // Resolved from the verified session, never from the payload. The second
      // flag is what decides whether a submitted `totalCostPrice` is honoured —
      // the cost is the one figure on this order the front desk may not touch.
      actorCanOrderExternalLab: await canOrderExternalLab(req),
      actorCanSetExternalLabCost: await canViewExternalLabCost(req),
    });
    // Save-and-close in one shot: the doctor never saw the "Generate PDF" button
    // in a saved state, so catch the Food List up here. Only reached once the
    // close has committed; never throws (see ensureFoodListPdf).
    if (close && created.status === "closed") {
      await ensureFoodListPdf(created.id, { name: actor.name, email: actor.email });
    }
    return json(created, 201);
  } catch (e) {
    return handleError(e);
  }
}
