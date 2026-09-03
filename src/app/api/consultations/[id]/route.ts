import {
  closeConsultation,
  deleteConsultation,
  updateConsultation,
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

// Edit an open consultation (evolving draft). `close: true` also finalizes it,
// converting any still-unpaid delta into a tracked ClientDebt.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const { close, ...input } = await readJson(req, createConsultationSchema);
    const actor = (await actingUser(req));
    let result = await updateConsultation(id, input, {
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      actorCanOfferBotox: await canOfferBotox(req),
      // Resolved from the verified session, never from the payload. The second
      // flag is what decides whether a submitted `totalCostPrice` is honoured —
      // the cost is the one figure on this order the front desk may not touch.
      actorCanOrderExternalLab: await canOrderExternalLab(req),
      actorCanSetExternalLabCost: await canViewExternalLabCost(req),
    });
    if (close) {
      result = await closeConsultation(id, {
        actorName: actor.name,
        actorEmail: actor.email,
        actorRole: actor.role,
      });
      // The visit is now read-only, so this is the last chance to produce the
      // Food List PDF for a doctor who filled the form in but never pressed
      // "Generate PDF" (or who ticked more boxes after generating). Runs after
      // the close has committed, outside its transaction, and never throws —
      // a failed render must not report a successful close as an error.
      await ensureFoodListPdf(id, { name: actor.name, email: actor.email });
    }
    return json(result);
  } catch (e) {
    return handleError(e);
  }
}

// Delete an open consultation opened by mistake. Clinical roles only; the repo
// enforces that a dietitian may delete only their own visit (admin: any), and
// refuses when money/debt is already recorded.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const actor = (await actingUser(req));
    await deleteConsultation(id, {
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
    });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
