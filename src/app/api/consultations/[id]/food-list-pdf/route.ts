import { db } from "@/server/db";
import { saveConsultationFile } from "@/server/repositories/consultationFiles";
import { renderFoodListPdf } from "@/server/pdf/food-list-pdf";
import { normalizeFoodListSelections } from "@/lib/food-list";
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
 * every role (see /api/consultation-files/[fileId]).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;

    const consultation = await db.consultation.findUnique({
      where: { id },
      select: {
        visitNumber: true,
        date: true,
        foodList: true,
        client: { select: { firstName: true, lastName: true } },
      },
    });
    if (!consultation) return json({ error: "Consultation not found" }, 404);
    // The form is saved with the rest of the visit; generating before that has
    // nothing to print. Tell the caller to save rather than emitting a blank form.
    if (!consultation.foodList) {
      return json({ error: "Save the food list before generating the PDF." }, 409);
    }

    const stored = consultation.foodList;
    let selections: string[] = [];
    try {
      const parsed = JSON.parse(stored.selections);
      if (Array.isArray(parsed)) selections = normalizeFoodListSelections(parsed.map(String));
    } catch {
      /* tolerant: a malformed list just prints as nothing ticked */
    }

    const data = await renderFoodListPdf({
      // The edition to print is whatever the doctor filled the form in as; item
      // ids are shared between languages, so the ticks carry across unchanged.
      language: stored.language === "ar" ? "ar" : "en",
      patientName: stored.patientName,
      notes: stored.notes ?? undefined,
      selections,
    });

    // Same sanitising rule as the blood-test upload path: the filename is echoed
    // back in Content-Disposition on download, so it must not carry separators.
    const patient = `${consultation.client.firstName} ${consultation.client.lastName}`;
    const safePatient = patient.replace(/[^\w.\- ()]/g, "_").trim() || "Patient";
    const day = consultation.date.toISOString().slice(0, 10);
    const filename = `Food List - ${safePatient} - Visit ${consultation.visitNumber} - ${day}.pdf`;

    const actor = await actingUser(req);
    const file = await saveConsultationFile(
      { consultationId: id, kind: "food-list", filename, mimeType: "application/pdf", data },
      { name: actor.name, email: actor.email },
    );
    return json(file, 201);
  } catch (e) {
    return handleError(e);
  }
}
