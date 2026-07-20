import { createStaff, listStaff } from "@/server/repositories/staff";
import { createStaffSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // R3: the staff directory (names, emails, roles) must not be world-readable.
    // Every signed-in role legitimately needs it (assigning a dietitian on a
    // client/appointment/consultation, the top-bar switcher), so require a known
    // acting role and reject unauthenticated/unknown callers — same bar as the
    // dashboard. Setting who staff ARE stays admin-only on POST below.
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    return json(await listStaff());
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Creating staff (and setting their role) is owner territory — admin only.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createStaffSchema);
    return json(await createStaff(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
