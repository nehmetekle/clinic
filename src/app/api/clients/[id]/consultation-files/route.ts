import { listClientConsultationFiles } from "@/server/repositories/consultationFiles";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * Every consultation-generated document for a patient, for the client profile's
 * Files tab. Open to all signed-in roles, matching the download route — the
 * secretary's Files tab shows these and nothing else, while the doctor/admin also
 * see blood-test results (which stay clinical-only, via a separate endpoint).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    return json(await listClientConsultationFiles(id));
  } catch (e) {
    return handleError(e);
  }
}
