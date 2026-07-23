import {
  deleteBloodSampleFile,
  getBloodSampleFileForDownload,
} from "@/server/repositories/bloodSampleFiles";
import { actingUser, canAttachSampleFile, canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * Download a blood-test file's content. Reading a lab result is a clinical right,
 * so it's doctor/admin only (`canViewClinical`) — the secretary can upload and see
 * that a file exists, but not open its contents. Served as an attachment.
 */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { fileId } = await params;
    const file = await getBloodSampleFileForDownload(fileId);
    if (!file) return json({ error: "File not found" }, 404);

    // filename is sanitized at upload (word chars, dots, dashes, spaces, parens),
    // so it's safe to place in the header; the RFC 5987 form covers any spaces.
    const disposition = `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
    return new Response(new Uint8Array(file.data), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": disposition,
        "Content-Length": String(file.data.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * Delete a blood-test file. Audited. Doctor/admin may remove any file; a secretary
 * may remove only a file she uploaded herself (undoing a wrong upload) — that
 * ownership check is enforced in the repository, inside the transaction.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const canDeleteAny = await canViewClinical(req);
    // A non-clinical uploader (secretary) can still delete, but only her own file.
    if (!canDeleteAny && !(await canAttachSampleFile(req))) {
      return json({ error: "Not allowed" }, 403);
    }
    const { fileId } = await params;
    const actor = await actingUser(req);
    await deleteBloodSampleFile(
      fileId,
      { name: actor.name, email: actor.email },
      canDeleteAny ? undefined : actor.id,
    );
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
