import { updateStaffSupplements } from "@/server/repositories/staff";
import { updateStaffSupplementsSchema } from "@/lib/validation";
import { actingUser } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

// A dietitian manages their own "Recommended supplements" options here. Stored
// per user, so one dietitian's list never affects another's — only the owning
// dietitian (or an admin, on their behalf) may edit a given id.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const actor = await actingUser(req);
    if (!actor.id || (actor.id !== id && actor.role !== "admin")) {
      return json({ error: "Not allowed" }, 403);
    }
    const { supplements } = await readJson(req, updateStaffSupplementsSchema);
    return json(await updateStaffSupplements(id, supplements));
  } catch (e) {
    return handleError(e);
  }
}
