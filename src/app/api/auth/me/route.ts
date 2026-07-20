import { getSessionTokenFromCookieHeader, resolveSessionToken } from "@/server/session";
import { json } from "@/server/http";

export async function GET(req: Request) {
  const token = getSessionTokenFromCookieHeader(req.headers.get("cookie"));
  const user = await resolveSessionToken(token);
  return json({ user });
}
