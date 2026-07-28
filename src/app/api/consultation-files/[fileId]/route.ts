import { getConsultationFileForDownload } from "@/server/repositories/consultationFiles";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * Download a consultation-generated document (the Food List PDF).
 *
 * Deliberately NOT clinical-gated, unlike a blood-test result: the finished form
 * is a printout handed to the patient, so the secretary needs it at the front
 * desk as much as the doctor does. Any signed-in role may fetch it; an
 * unauthenticated request still gets nothing (`actingRole` fails closed).
 */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const { fileId } = await params;
    const file = await getConsultationFileForDownload(fileId);
    if (!file) return json({ error: "File not found" }, 404);

    // filename is sanitized at generation (word chars, dots, dashes, spaces,
    // parens), so it's safe in the header; the RFC 5987 form covers any spaces.
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
