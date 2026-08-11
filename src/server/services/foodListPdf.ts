import { db } from "@/server/db";
import { saveConsultationFile } from "@/server/repositories/consultationFiles";
import { renderFoodListPdf } from "@/server/pdf/food-list-pdf";
import { normalizeFoodListSelections } from "@/lib/food-list";
import { ConflictError, NotFoundError } from "@/server/http";
import type { ConsultationFile } from "@/lib/types";

/**
 * Rendering + attaching the Nutrient-Rich Foods List PDF for a visit.
 *
 * Extracted from the route handler so the close-consultation path can reuse it:
 * the doctor generating the PDF by hand and the automatic catch-up at close must
 * produce byte-identical output, which they only reliably do by sharing a
 * function. Rendering reads fonts and artwork from disk (pdf-lib, Node runtime
 * only) and takes real time, so nothing here belongs inside a DB transaction.
 */

/** The one `kind` of consultation file this service manages. */
const FOOD_LIST_KIND = "food-list";

/** Who the generated file is attributed to (frozen onto the row + audit entry). */
export type PdfActor = { name: string; email?: string };

const consultationSelect = {
  visitNumber: true,
  date: true,
  foodList: true,
  client: { select: { firstName: true, lastName: true } },
} as const;

/** Ticked catalog ids on a saved form, tolerating a malformed/legacy blob. */
function parseSelections(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeFoodListSelections(parsed.map(String));
  } catch {
    /* tolerant: a malformed list just prints as nothing ticked */
  }
  return [];
}

/**
 * Renders the Food List PDF for `consultationId` and attaches it to the visit,
 * replacing any previously generated copy.
 *
 * Throws {@link NotFoundError} when the visit doesn't exist and
 * {@link ConflictError} when the form hasn't been saved yet — generating before
 * the save has nothing to print, and emitting a blank sheet would be worse than
 * telling the caller to save.
 */
export async function generateFoodListPdf(
  consultationId: string,
  actor: PdfActor,
): Promise<ConsultationFile> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: consultationSelect,
  });
  if (!consultation) throw new NotFoundError("Consultation not found");
  if (!consultation.foodList) {
    throw new ConflictError("Save the food list before generating the PDF.");
  }

  const stored = consultation.foodList;
  const data = await renderFoodListPdf({
    // The edition to print is whatever the doctor filled the form in as; item
    // ids are shared between languages, so the ticks carry across unchanged.
    language: stored.language === "ar" ? "ar" : "en",
    patientName: stored.patientName,
    notes: stored.notes ?? undefined,
    selections: parseSelections(stored.selections),
  });

  // Same sanitising rule as the blood-test upload path: the filename is echoed
  // back in Content-Disposition on download, so it must not carry separators.
  const patient = `${consultation.client.firstName} ${consultation.client.lastName}`;
  const safePatient = patient.replace(/[^\w.\- ()]/g, "_").trim() || "Patient";
  const day = consultation.date.toISOString().slice(0, 10);
  const filename = `Food List - ${safePatient} - Visit ${consultation.visitNumber} - ${day}.pdf`;

  return saveConsultationFile(
    {
      consultationId,
      kind: FOOD_LIST_KIND,
      filename,
      mimeType: "application/pdf",
      data,
    },
    actor,
  );
}

/**
 * Catch-up generation, called after a visit is closed.
 *
 * A doctor who fills the Food List in but closes the visit without pressing
 * "Generate PDF" would otherwise leave the front desk with nothing to hand over
 * or send — and a closed visit is read-only, so there's no going back to
 * generate it. This makes the manual button a convenience rather than a step
 * that can be forgotten.
 *
 * Generates when a form exists with at least one tick and either no PDF has been
 * made yet, or the form was edited after the last one was (ticking three more
 * boxes and then closing must not leave a stale sheet attached —
 * `saveConsultationFile` replaces in place, so this stays one current file).
 * Does nothing when no form was filled in: there is nothing to print.
 *
 * **Never throws.** Close has already committed by the time this runs; a font
 * that won't load or a render bug must not turn a finalized visit into an error
 * the doctor sees, or worse, invite them to retry a close that already happened.
 * Returns the file when one was written, `null` otherwise.
 */
export async function ensureFoodListPdf(
  consultationId: string,
  actor: PdfActor,
): Promise<ConsultationFile | null> {
  try {
    const consultation = await db.consultation.findUnique({
      where: { id: consultationId },
      select: {
        foodList: { select: { selections: true, updatedAt: true } },
        files: {
          where: { kind: FOOD_LIST_KIND },
          select: { createdAt: true },
          take: 1,
        },
      },
    });

    const form = consultation?.foodList;
    if (!form) return null; // no form filled in for this visit
    if (parseSelections(form.selections).length === 0) return null; // nothing ticked

    const existing = consultation.files[0];
    // Up to date already — the doctor generated it and changed nothing after.
    if (existing && existing.createdAt >= form.updatedAt) return null;

    return await generateFoodListPdf(consultationId, actor);
  } catch (e) {
    console.error(`Food List PDF catch-up failed for consultation ${consultationId}`, e);
    return null;
  }
}
