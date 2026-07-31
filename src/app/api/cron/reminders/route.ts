import { runAppointmentReminders } from "@/server/reminders";
import { json } from "@/server/http";

// Hit by Vercel Cron on a schedule (see vercel.json). Not a user endpoint — it's
// guarded by CRON_SECRET instead of a session: Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` when that env var is set, so anyone
// without the secret gets 401 and can't trigger a reminder sweep.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, 401);
  }
  const summary = await runAppointmentReminders();
  return json({ ok: true, ...summary });
}
