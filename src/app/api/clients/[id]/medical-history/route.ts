import {
  getMedicalHistory,
  upsertMedicalHistory,
} from "@/server/repositories/medicalHistory";
import { medicalHistorySchema } from "@/lib/validation";
import { canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Medical history is clinical data — dietitian/admin only, same as
    // consultations. The secretary's UI never shows this tab.
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    return json(await getMedicalHistory(id));
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, medicalHistorySchema);
    return json(await upsertMedicalHistory(id, input));
  } catch (e) {
    return handleError(e);
  }
}
