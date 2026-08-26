import { createBotoxItem, listBotoxItems } from "@/server/repositories/botoxItems";
import { createBotoxItemSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { withoutCost } from "@/server/serialize";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const rows = await listBotoxItems();
    // `cost`/margin is owner-only — everyone who can reach the consultation
    // editor reads this catalog to pick a Botox item, but only the admin gets
    // the clinic's cost figures.
    return json(role === "admin" ? rows : rows.map(withoutCost));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // The Botox catalog & pricing are admin-only — everyone who can reach it can read.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createBotoxItemSchema);
    return json(await createBotoxItem(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
