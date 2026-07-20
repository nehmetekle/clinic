import {
  createAppointment,
  listAppointments,
} from "@/server/repositories/appointments";
import { createAppointmentSchema } from "@/lib/validation";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Any signed-in role uses the schedule/queue; reject only unknown callers.
    if (!(await actingRole(req))) return json([]);
    const date = new URL(req.url).searchParams.get("date") ?? undefined;
    return json(
      await listAppointments(date, {
        includeMedicalHistoryStatus: (await canViewClinical(req)),
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createAppointmentSchema);
    return json(
      await createAppointment(input, {
        includeMedicalHistoryStatus: (await canViewClinical(req)),
      }),
      201,
    );
  } catch (e) {
    return handleError(e);
  }
}
