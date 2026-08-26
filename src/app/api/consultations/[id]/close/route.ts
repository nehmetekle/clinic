import { closeConsultation } from "@/server/repositories/consultations";
import { ensureFoodListPdf } from "@/server/services/foodListPdf";
import { actingUser, canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

// Close an open visit WITHOUT editing it — the "Close visit" action offered on a
// visit list (Appointments & history), where there is no form state to send.
// Deliberately separate from `PATCH /api/consultations/[id]`: that one closes as
// the tail of a full-payload edit, so reusing it from a list would rewrite the
// visit from an empty form. Everything else is the same code path — the same
// `closeConsultation` (ownership, already-closed and unsettled-basket guards all
// live there) and the same Food List catch-up afterwards.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const actor = await actingUser(req);
    const result = await closeConsultation(id, {
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
    });
    // Same last-chance render as the edit-and-close path: the visit is read-only
    // from here, and this never throws (the close has already committed).
    await ensureFoodListPdf(id, { name: actor.name, email: actor.email });
    return json(result);
  } catch (e) {
    return handleError(e);
  }
}
