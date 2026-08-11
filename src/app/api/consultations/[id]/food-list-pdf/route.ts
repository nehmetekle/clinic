import { generateFoodListPdf } from "@/server/services/foodListPdf";
import { actingUser, canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

// Renders with pdf-lib and stores the bytes inline in Postgres, so this route
// runs on the Node runtime (Buffer + fs, no Edge).

/**
 * Generate the Nutrient-Rich Foods List PDF for a visit and attach it to that
 * consultation, replacing any previously generated copy.
 *
 * Clinical-only, matching the consultation editor this is triggered from — the
 * doctor fills the form in. Downloading the finished PDF afterwards is open to
 * every role (see /api/consultation-files/[fileId]), as is sending it on via
 * WhatsApp. Closing a visit generates this automatically if the doctor never
 * pressed the button (see `ensureFoodListPdf`).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const actor = await actingUser(req);
    const file = await generateFoodListPdf(id, { name: actor.name, email: actor.email });
    return json(file, 201);
  } catch (e) {
    return handleError(e);
  }
}
