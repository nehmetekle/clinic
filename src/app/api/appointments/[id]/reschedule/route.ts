import { rescheduleAppointment } from "@/server/repositories/appointments";
import { rescheduleAppointmentSchema } from "@/lib/validation";
import { canManageAppointments, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

/**
 * Move a booking to a new slot. Kept off the sibling `PATCH /appointments/[id]`
 * (which is the status-transition endpoint used by the queue and cancellation)
 * so the two writes stay separate: this one never touches status, that one never
 * touches the slot.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canManageAppointments(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, rescheduleAppointmentSchema);
    return json(
      await rescheduleAppointment(id, input, {
        includeMedicalHistoryStatus: (await canViewClinical(req)),
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
