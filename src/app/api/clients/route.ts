import { createClient, listClients } from "@/server/repositories/clients";
import { createClientSchema } from "@/lib/validation";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const q = new URL(req.url).searchParams.get("q") ?? undefined;
    return json(await listClients({ q, includeClinical: (await canViewClinical(req)) }));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    // Registration can also record an opening payment — require a signed-in
    // role, reject unknown callers.
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createClientSchema);
    const created = await createClient({ ...input, email: input.email || undefined });
    return json(created, 201);
  } catch (e) {
    return handleError(e);
  }
}
