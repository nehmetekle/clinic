import { db } from "@/server/db";
import type { FailureContext } from "@/server/observability";
import { saveConsultationFile } from "@/server/repositories/consultationFiles";
import { renderFoodListPdf } from "@/server/pdf/food-list-pdf";
import { isFoodListPdfStale, normalizeFoodListSelections } from "@/lib/food-list";
import { ConflictError, NotFoundError } from "@/server/http";
import { reportFailure } from "@/server/observability";
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

/** What asked for this render — carried into the failure event so a silent
 * close-time failure is distinguishable from a doctor's button press. */
export type PdfTrigger = "manual" | "close";

/** The event name to alert on. One string for every Food List PDF failure. */
const PDF_FAILURE_EVENT = "food_list_pdf.failed";

/** Errors already reported, so a failure isn't logged twice as it unwinds. */
const reportedErrors = new WeakSet<object>();

/**
 * Runs one stage of the render and reports it if it blows up.
 *
 * `NotFoundError`/`ConflictError` are expected answers ("no such visit", "save
 * the form first"), not incidents — they're returned to the caller and never
 * alerted on. Everything else (a font missing from the deployment, a Postgres
 * outage, a pdf-lib bug) is the silent-failure case #6 is about.
 */
async function inStage<T>(
  stage: string,
  context: FailureContext,
  redact: readonly (string | null | undefined)[],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const expected = e instanceof NotFoundError || e instanceof ConflictError;
    const seen = typeof e === "object" && e !== null && reportedErrors.has(e);
    if (!expected && !seen) {
      if (typeof e === "object" && e !== null) reportedErrors.add(e);
      reportFailure(PDF_FAILURE_EVENT, { ...context, stage }, e, { redact });
    }
    throw e;
  }
}

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
  trigger: PdfTrigger = "manual",
): Promise<ConsultationFile> {
  // Ids and flags only — never the patient's name or what they eat. See
  // src/server/observability.ts.
  const context: FailureContext = { consultationId, trigger };

  const consultation = await inStage("load", context, [], () =>
    db.consultation.findUnique({ where: { id: consultationId }, select: consultationSelect }),
  );
  if (!consultation) throw new NotFoundError("Consultation not found");
  if (!consultation.foodList) {
    throw new ConflictError("Save the food list before generating the PDF.");
  }

  const stored = consultation.foodList;
  const client = consultation.client;
  // The patient's name reaches pdf-lib and the filename, so it can end up quoted
  // in an error message; scrub it out of anything we log.
  const redact = [client.firstName, client.lastName, `${client.firstName} ${client.lastName}`];
  const selections = parseSelections(stored.selections);
  const language = stored.language === "ar" ? "ar" : "en";

  const data = await inStage(
    "render",
    // Shape of the job, not its contents: enough to tell "the Arabic edition
    // broke" or "only huge forms fail" apart without logging a single answer.
    { ...context, language, selectionCount: selections.length },
    redact,
    () =>
      renderFoodListPdf({
        // The edition to print is whatever the doctor filled the form in as; item
        // ids are shared between languages, so the ticks carry across unchanged.
        language,
        patientName: stored.patientName,
        notes: stored.notes ?? undefined,
        selections,
      }),
  );

  // Same sanitising rule as the blood-test upload path: the filename is echoed
  // back in Content-Disposition on download, so it must not carry separators.
  const patient = `${client.firstName} ${client.lastName}`;
  const safePatient = patient.replace(/[^\w.\- ()]/g, "_").trim() || "Patient";
  const day = consultation.date.toISOString().slice(0, 10);
  const filename = `Food List - ${safePatient} - Visit ${consultation.visitNumber} - ${day}.pdf`;

  return inStage("store", { ...context, bytes: data.length }, redact, () =>
    saveConsultationFile(
      {
        consultationId,
        kind: FOOD_LIST_KIND,
        filename,
        mimeType: "application/pdf",
        data,
      },
      actor,
    ),
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
          // Newest first: "is the attached sheet older than the form?" is only a
          // meaningful question about the current file. The DB now allows just
          // one per kind, but ordering keeps the comparison correct rather than
          // resting on that (and on any row that predates the constraint).
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const form = consultation?.foodList;
    if (!form) return null; // no form filled in for this visit
    if (parseSelections(form.selections).length === 0) return null; // nothing ticked

    const existing = consultation.files[0];
    // Up to date already — the doctor generated it and changed nothing after.
    // Same predicate the file listings flag `stale` with, so the close-time
    // decision and the "don't send this" warning can never disagree.
    if (existing && !isFoodListPdfStale(existing.createdAt, form.updatedAt)) return null;

    return await generateFoodListPdf(consultationId, actor, "close");
  } catch (e) {
    // Swallowed on purpose (the visit is already closed — see the note above),
    // which is exactly why it has to be reported: this is the path that would
    // otherwise stay broken in production with nobody the wiser. `inStage` has
    // already emitted the precise stage for anything raised inside the render;
    // this catches what happens outside it (the lookup above) and guarantees an
    // event either way.
    if (!(typeof e === "object" && e !== null && reportedErrors.has(e))) {
      reportFailure(PDF_FAILURE_EVENT, { consultationId, trigger: "close", stage: "catch-up" }, e);
    }
    return null;
  }
}
