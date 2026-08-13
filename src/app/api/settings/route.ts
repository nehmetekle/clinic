import { getSettings, updateSettings } from "@/server/repositories/settings";
import { updateSettingsSchema } from "@/lib/validation";
import { handleError, json, readJson } from "@/server/http";
import { actingRole, actingUser } from "@/server/auth";
import { userIdByEmail } from "@/server/repositories/staff";

export async function GET(req: Request) {
  try {
    // Every signed-in role reads this (e.g. the top bar's exchange rate display).
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    return json(await getSettings());
  } catch (e) {
    return handleError(e);
  }
}

export async function PUT(req: Request) {
  try {
    // Clinic-wide settings (like the exchange rate) are admin-only; everyone can read.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, updateSettingsSchema);
    // The actor recorded in the rate history is resolved HERE, from the verified
    // session — never taken from the request body, so it cannot be forged.
    const actor = await actingUser(req);
    return json(
      await updateSettings({
        ...input,
        actorId: await userIdByEmail(actor.email),
        actorName: actor.name,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
