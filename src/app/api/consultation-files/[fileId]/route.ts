import {
  getConsultationFileForDownload,
  isConsultationFileStale,
} from "@/server/repositories/consultationFiles";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";
import { WHATSAPP_STALE_MESSAGE } from "@/lib/whatsapp";

/**
 * Download a consultation-generated document (the Food List PDF).
 *
 * Deliberately NOT clinical-gated, unlike a blood-test result: the finished form
 * is a printout handed to the patient, so the secretary needs it at the front
 * desk as much as the doctor does. Any signed-in role may fetch it; an
 * unauthenticated request still gets nothing (`actingRole` fails closed).
 *
 * `?intent=send` means "this is going to the patient", and is refused when the
 * Food List has been edited since this PDF was rendered. The UI already hides the
 * send button on a stale file, but that flag is only as fresh as the listing it
 * came from — a Files tab left open while the doctor edits the form in another
 * tab still shows a live button, so the guarantee that a superseded sheet never
 * reaches a patient has to be made here, at the moment the bytes are handed out.
 * A plain download (no intent) is unaffected: staff may still fetch the old sheet
 * deliberately, and printing it is their call.
 *
 * `?disposition=inline` asks for the PDF to be *displayed* rather than saved, so
 * the Print button can open it in the browser's own PDF viewer (which owns the
 * print dialog). Same bytes, same access rules — only the header differs.
 */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const { fileId } = await params;

    if (new URL(req.url).searchParams.get("intent") === "send") {
      if (await isConsultationFileStale(fileId)) {
        return json({ error: WHATSAPP_STALE_MESSAGE, code: "stale_food_list" }, 409);
      }
    }

    const file = await getConsultationFileForDownload(fileId);
    if (!file) return json({ error: "File not found" }, 404);

    // filename is sanitized at generation (word chars, dots, dashes, spaces,
    // parens), so it's safe in the header; the RFC 5987 form covers any spaces.
    const inline = new URL(req.url).searchParams.get("disposition") === "inline";
    const disposition = `${inline ? "inline" : "attachment"}; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
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
