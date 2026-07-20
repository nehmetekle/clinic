import { db } from "@/server/db";
import {
  getSessionTokenFromCookieHeader,
  resolveSessionToken,
  revokeSessionByToken,
  clearSessionCookie,
} from "@/server/session";
import { writeAudit } from "@/server/repositories/audit";
import { json } from "@/server/http";

export async function POST(req: Request) {
  const token = getSessionTokenFromCookieHeader(req.headers.get("cookie"));
  const user = await resolveSessionToken(token);
  await revokeSessionByToken(token);
  if (user) {
    await writeAudit(db, {
      userId: user.id,
      userName: user.name,
      action: "Logged out",
      entityType: "User",
      entityLabel: user.name,
    });
  }
  const res = json({ ok: true });
  clearSessionCookie(res);
  return res;
}
