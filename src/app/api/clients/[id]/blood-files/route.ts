import { listClientBloodFiles } from "@/server/repositories/bloodSampleFiles";
import { canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * Every blood-test file for a patient, for the client profile's Files tab. That
 * tab is the doctor's/admin's, so this is gated on clinical access.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    return json(await listClientBloodFiles(id));
  } catch (e) {
    return handleError(e);
  }
}
