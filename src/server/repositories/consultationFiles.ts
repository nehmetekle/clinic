import { Prisma } from "@prisma/client";
import { isFoodListPdfStale } from "@/lib/food-list";
import { db } from "../db";
import { NotFoundError } from "../http";
import { writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { ClientConsultationFile, ConsultationFile } from "@/lib/types";

/** Acting user for a file change — mirrors the blood-sample file actor: the email
 * resolves to a User row, the name is frozen onto the row and the audit entry. */
type FileActor = { name: string; email?: string };

/** Columns for a metadata listing — everything EXCEPT the `data` blob, so listing
 * a patient's documents never drags the PDF bytes over the wire. */
const metaSelect = {
  id: true,
  consultationId: true,
  kind: true,
  filename: true,
  mimeType: true,
  size: true,
  uploadedById: true,
  uploadedByName: true,
  createdAt: true,
  // When the form behind this file last moved. Cheap (one timestamp on a 1–1
  // row, never the answers themselves) and it's what makes every listing able to
  // say whether the PDF still matches the form — the flag "Send via WhatsApp"
  // refuses on.
  consultation: { select: { foodList: { select: { updatedAt: true } } } },
} satisfies Prisma.ConsultationFileSelect;

type MetaRow = Prisma.ConsultationFileGetPayload<{ select: typeof metaSelect }>;

function toConsultationFile(f: MetaRow): ConsultationFile {
  return {
    id: f.id,
    consultationId: f.consultationId,
    kind: f.kind as ConsultationFile["kind"],
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size,
    uploadedById: f.uploadedById,
    uploadedByName: f.uploadedByName,
    createdAt: f.createdAt.toISOString(),
    stale: isFoodListPdfStale(f.createdAt, f.consultation.foodList?.updatedAt),
  };
}

/** Files generated against one consultation, newest first. Metadata only. */
export async function listConsultationFiles(consultationId: string): Promise<ConsultationFile[]> {
  const rows = await db.consultationFile.findMany({
    where: { consultationId },
    select: metaSelect,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toConsultationFile);
}

/** Every consultation-generated document for a patient, with the visit it came
 * from — powers the client profile's Files tab. Newest first. Metadata only. */
export async function listClientConsultationFiles(
  clientId: string,
): Promise<ClientConsultationFile[]> {
  const rows = await db.consultationFile.findMany({
    where: { consultation: { clientId } },
    select: {
      ...metaSelect,
      consultation: {
        select: { visitNumber: true, date: true, foodList: { select: { updatedAt: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((f) => ({
    ...toConsultationFile(f),
    clientId,
    visitNumber: f.consultation.visitNumber,
    visitDate: f.consultation.date.toISOString(),
  }));
}

/**
 * Stores a generated document against a consultation, replacing any previous file
 * of the same `kind` for that visit.
 *
 * Replace-in-place is deliberate: regenerating the Food List after ticking one
 * more box should leave the visit with ONE current PDF, not a pile of
 * near-identical ones the front desk has to choose between. The audit log keeps
 * the history of who regenerated it and when.
 *
 * That invariant is the database's now (`@@unique([consultationId, kind])`), not
 * a timing assumption: the doctor's "Generate PDF" and the automatic catch-up at
 * close can render simultaneously, and the old find-then-create pair let both
 * inserts through. A single upsert replaces the row in place; the one case it
 * can't absorb — two upserts both finding no row and both inserting — surfaces as
 * a unique-constraint violation, which is retried as a plain replace rather than
 * shown to the doctor (whichever render finishes last is the current sheet, and
 * both are byte-identical anyway).
 */
export async function saveConsultationFile(
  input: {
    consultationId: string;
    kind: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  },
  actor: FileActor,
): Promise<ConsultationFile> {
  const userId = await userIdByEmail(actor.email);

  try {
    return await storeConsultationFile(input, actor, userId);
  } catch (e) {
    // Lost an insert race with a concurrent generator: the row it created is now
    // there, so the retry takes the update path and wins cleanly. A second
    // failure is a real error and propagates.
    if (isUniqueViolation(e)) return storeConsultationFile(input, actor, userId);
    throw e;
  }
}

/** True for Prisma's unique-constraint violation (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** One attempt at the replace-in-place write. See {@link saveConsultationFile}. */
async function storeConsultationFile(
  input: {
    consultationId: string;
    kind: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  },
  actor: FileActor,
  userId: string | null,
): Promise<ConsultationFile> {
  return db.$transaction(async (tx) => {
    const consultation = await tx.consultation.findUnique({
      where: { id: input.consultationId },
      select: {
        visitNumber: true,
        client: { select: { firstName: true, lastName: true } },
      },
    });
    if (!consultation) throw new NotFoundError("Consultation not found");

    const existing = await tx.consultationFile.findUnique({
      where: {
        consultationId_kind: { consultationId: input.consultationId, kind: input.kind },
      },
      select: { id: true },
    });

    const fields = {
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.data.length,
      // Copy into a fresh Uint8Array so the type is the plain-ArrayBuffer shape
      // Prisma's Bytes input expects (same as the blood-sample file path).
      data: new Uint8Array(input.data),
      uploadedById: userId,
      uploadedByName: actor.name,
      // `createdAt` is when the CURRENT file was generated — the staleness check
      // at close compares it against the form's `updatedAt` (see
      // ensureFoodListPdf). Replacing in place has to move it forward, exactly
      // as the delete-and-recreate it replaces used to, or a regenerated sheet
      // would look older than the edit that prompted it forever.
      createdAt: new Date(),
    };

    const created = await tx.consultationFile.upsert({
      where: {
        consultationId_kind: { consultationId: input.consultationId, kind: input.kind },
      },
      create: { consultationId: input.consultationId, kind: input.kind, ...fields },
      update: fields,
      select: metaSelect,
    });

    const c = consultation.client;
    await writeAudit(tx, {
      userId,
      userName: actor.name,
      action: existing ? "Regenerated Food List PDF" : "Generated Food List PDF",
      entityType: "Consultation",
      entityLabel: `${c.firstName} ${c.lastName} — Visit #${consultation.visitNumber}`,
    });

    return toConsultationFile(created);
  });
}

/**
 * Is this file superseded by a later edit to the form it prints?
 *
 * The authoritative answer at action time, for callers that can't trust a flag
 * fetched earlier (see the `?intent=send` guard on the download route). Reads two
 * timestamps and nothing else. A file that doesn't exist isn't stale — the
 * download path answers 404 for that on its own.
 */
export async function isConsultationFileStale(fileId: string): Promise<boolean> {
  const row = await db.consultationFile.findUnique({
    where: { id: fileId },
    select: {
      createdAt: true,
      consultation: { select: { foodList: { select: { updatedAt: true } } } },
    },
  });
  if (!row) return false;
  return isFoodListPdfStale(row.createdAt, row.consultation.foodList?.updatedAt);
}

/** Fetches one file's bytes for download (the only path that reads `data`). */
export async function getConsultationFileForDownload(
  fileId: string,
): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
  const row = await db.consultationFile.findUnique({
    where: { id: fileId },
    select: { filename: true, mimeType: true, data: true },
  });
  if (!row) return null;
  return { filename: row.filename, mimeType: row.mimeType, data: Buffer.from(row.data) };
}
