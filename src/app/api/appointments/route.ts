import {
  createAppointment,
  listAppointments,
} from "@/server/repositories/appointments";
import { createAppointmentSchema } from "@/lib/validation";
import { actingRole, actingUser, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Any signed-in role uses the schedule/queue; reject only unknown callers.
    if (!(await actingRole(req))) return json([]);
    const params = new URL(req.url).searchParams;
    const date = params.get("date") ?? undefined;
    // `scope=mine` narrows the list to the caller's own bookings. Only meaningful
    // for a dietitian — an admin/secretary oversees every doctor's schedule, so
    // the flag is ignored for them.
    const actor = await actingUser(req);
    const dietitianId =
      params.get("scope") === "mine" && actor.role === "dietitian" && actor.id
        ? actor.id
        : undefined;
    return json(
      await listAppointments(date, {
        includeMedicalHistoryStatus: (await canViewClinical(req)),
        dietitianId,
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
