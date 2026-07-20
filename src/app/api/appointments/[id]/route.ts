import { z } from "zod";
import { updateAppointmentStatus } from "@/server/repositories/appointments";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

const patchSchema = z.object({
  status: z.enum([
    "scheduled",
    "checked_in",
    "with_dietitian",
    "completed",
    "cancelled",
    "no_show",
  ]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const { status } = await readJson(req, patchSchema);
    return json(
      await updateAppointmentStatus(id, status, {
        includeMedicalHistoryStatus: (await canViewClinical(req)),
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
