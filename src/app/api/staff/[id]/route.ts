import { updateStaff } from "@/server/repositories/staff";
import { updateStaffSchema } from "@/lib/validation";
import { actingUser } from "@/server/auth";
import { ForbiddenError } from "@/server/http";
import { handleError, json, readJson } from "@/server/http";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Editing staff details (name, email, phone, role, status) is owner
    // territory — admin only.
    const me = await actingUser(req);
    if (me.role !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateStaffSchema);

    // Guardrails against an admin locking themselves out of admin: you can't
    // demote your own role away from admin, nor deactivate your own account.
    if (me.id === id) {
      if (input.role !== undefined && input.role !== "admin") {
        throw new ForbiddenError("You can't change your own role — ask another admin.");
      }
      if (input.status === "inactive") {
        throw new ForbiddenError("You can't deactivate your own account.");
      }
    }

    return json(await updateStaff(id, input));
  } catch (e) {
    return handleError(e);
  }
}
