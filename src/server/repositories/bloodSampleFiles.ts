import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError } from "../http";
import { writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { BloodSampleFile, ClientBloodFile } from "@/lib/types";

/** Acting user for a file change — email resolves to a User row, name is stamped
 * onto the audit entry and frozen onto the row (mirrors the blood-sample actor). */
type FileActor = { name: string; email?: string };

/** Columns for a metadata listing — everything EXCEPT the (potentially large)
 * `data` blob, so browsing a sample's files never pulls the bytes over the wire. */
const metaSelect = {
  id: true,
  bloodSampleId: true,
  filename: true,
  mimeType: true,
  size: true,
  uploadedById: true,
  uploadedByName: true,
  createdAt: true,
} satisfies Prisma.BloodSampleFileSelect;

type MetaRow = Prisma.BloodSampleFileGetPayload<{ select: typeof metaSelect }>;

function toBloodSampleFile(f: MetaRow): BloodSampleFile {
  return {
    id: f.id,
    bloodSampleId: f.bloodSampleId,
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size,
    uploadedById: f.uploadedById,
    uploadedByName: f.uploadedByName,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Files attached to one blood test, newest first. Metadata only. */
export async function listBloodSampleFiles(bloodSampleId: string): Promise<BloodSampleFile[]> {
  const rows = await db.bloodSampleFile.findMany({
    where: { bloodSampleId },
    select: metaSelect,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toBloodSampleFile);
}

/** Every blood-test file for a patient, with the test it belongs to — powers the
 * client profile's Files tab. Newest upload first. Metadata only. */
export async function listClientBloodFiles(clientId: string): Promise<ClientBloodFile[]> {
  const rows = await db.bloodSampleFile.findMany({
    where: { bloodSample: { clientId } },
    select: {
      ...metaSelect,
      bloodSample: { select: { tests: true, orderedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((f) => {
    let tests: string[] = [];
    try {
      const parsed = JSON.parse(f.bloodSample.tests);
      if (Array.isArray(parsed)) tests = parsed.map(String);
    } catch {
      /* tolerant: a malformed test list just shows as none */
    }
    return {
      ...toBloodSampleFile(f),
      clientId,
      tests,
      orderedAt: f.bloodSample.orderedAt.toISOString(),
    };
  });
}

/**
 * Attaches a file to a blood test. Verifies the sample exists first (so a file
 * can never dangle), stores the bytes inline, and audits the upload attributed to
 * the acting user — the same accountability trail the sample's send/receive/note
 * actions write, so a test's file history is as traceable as its status history.
 */
export async function createBloodSampleFile(
  input: {
    bloodSampleId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  },
  actor: FileActor,
): Promise<BloodSampleFile> {
  const userId = await userIdByEmail(actor.email);

  return db.$transaction(async (tx) => {
    const sample = await tx.bloodSample.findUnique({
      where: { id: input.bloodSampleId },
      include: { client: true },
    });
    if (!sample) throw new NotFoundError("Blood sample not found");

    // Result files are lab results — they only exist once the results are in.
    // Block attaching to a sample still awaiting send / at the lab (the UI hides
    // the upload there too, but the server is the authority). `receivedAt` set is
    // exactly the "received" status the board's "Results received" column shows.
    if (!sample.receivedAt) {
      throw new ConflictError(
        "Results aren't in yet — you can attach lab result files once the results are received.",
      );
    }

    const created = await tx.bloodSampleFile.create({
      data: {
        bloodSampleId: input.bloodSampleId,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.data.length,
        // Copy into a fresh Uint8Array so the type is the plain-ArrayBuffer shape
        // Prisma's Bytes input expects (a Node Buffer is backed by ArrayBufferLike).
        data: new Uint8Array(input.data),
        uploadedById: userId,
        uploadedByName: actor.name,
      },
      select: metaSelect,
    });

    const clientName = `${sample.client.firstName} ${sample.client.lastName}`;
    await writeAudit(tx, {
      userId,
      userName: actor.name,
      action: "Attached blood test file",
      entityType: "BloodSample",
      entityLabel: `${clientName} — uploaded "${input.filename}"`,
    });

    return toBloodSampleFile(created);
  });
}

/** Fetches one file's bytes for download (the only path that reads `data`). */
export async function getBloodSampleFileForDownload(
  fileId: string,
): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
  const row = await db.bloodSampleFile.findUnique({
    where: { id: fileId },
    select: { filename: true, mimeType: true, data: true },
  });
  if (!row) return null;
  return { filename: row.filename, mimeType: row.mimeType, data: Buffer.from(row.data) };
}

/**
 * Removes a file attachment and audits the deletion. Doctor/admin may delete any
 * file; a secretary may only delete a file she uploaded herself (self-correcting a
 * wrong upload). The caller passes `restrictToUploaderId` for that narrower case —
 * when set, the delete only proceeds if the file's uploader matches (checked here,
 * inside the transaction, so it can't be bypassed).
 */
export async function deleteBloodSampleFile(
  fileId: string,
  actor: FileActor,
  restrictToUploaderId?: string | null,
): Promise<void> {
  const userId = await userIdByEmail(actor.email);

  await db.$transaction(async (tx) => {
    const existing = await tx.bloodSampleFile.findUnique({
      where: { id: fileId },
      select: {
        filename: true,
        uploadedById: true,
        bloodSample: { select: { client: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!existing) throw new NotFoundError("File not found");

    // Ownership gate for the non-clinical (secretary) case: only her own upload.
    if (restrictToUploaderId !== undefined) {
      if (!restrictToUploaderId || existing.uploadedById !== restrictToUploaderId) {
        throw new ForbiddenError("You can only remove a file you uploaded yourself.");
      }
    }

    await tx.bloodSampleFile.delete({ where: { id: fileId } });

    const c = existing.bloodSample.client;
    await writeAudit(tx, {
      userId,
      userName: actor.name,
      action: "Deleted blood test file",
      entityType: "BloodSample",
      entityLabel: `${c.firstName} ${c.lastName} — removed "${existing.filename}"`,
    });
  });
}
