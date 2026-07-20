import { updateBloodSample } from "@/server/repositories/bloodSamples";
import { updateBloodSampleSchema } from "@/lib/validation";
import { actingUser, canTrackSamples } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Sending samples / logging results is the secretary's (and admin's) action.
    if (!(await canTrackSamples(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateBloodSampleSchema);
    return json(await updateBloodSample(id, input, (await actingUser(req))));
  } catch (e) {
    return handleError(e);
  }
}
