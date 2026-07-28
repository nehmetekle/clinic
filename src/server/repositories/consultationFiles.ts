import { Prisma } from "@prisma/client";
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
      consultation: { select: { visitNumber: true, date: true } },
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

  return db.$transaction(async (tx) => {
    const consultation = await tx.consultation.findUnique({
      where: { id: input.consultationId },
      select: {
        visitNumber: true,
        client: { select: { firstName: true, lastName: true } },
      },
    });
    if (!consultation) throw new NotFoundError("Consultation not found");

    const existing = await tx.consultationFile.findFirst({
      where: { consultationId: input.consultationId, kind: input.kind },
      select: { id: true },
    });
    if (existing) await tx.consultationFile.delete({ where: { id: existing.id } });

    const created = await tx.consultationFile.create({
      data: {
        consultationId: input.consultationId,
        kind: input.kind,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.data.length,
        // Copy into a fresh Uint8Array so the type is the plain-ArrayBuffer shape
        // Prisma's Bytes input expects (same as the blood-sample file path).
        data: new Uint8Array(input.data),
        uploadedById: userId,
        uploadedByName: actor.name,
      },
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
