import { runAppointmentReminders } from "@/server/reminders";
import { json } from "@/server/http";

// Hit by an external scheduler (cron-job.org) on a schedule to fire due reminders.
// Guarded by CRON_SECRET instead of a session. The secret may be supplied two ways
// so any scheduler works: as `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron
// sends automatically), or as a `?key=<CRON_SECRET>` query param (so a scheduler
// needs only a URL — no custom-header config). Anyone without it gets 401.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const key = new URL(req.url).searchParams.get("key");
    if (auth !== `Bearer ${secret}` && key !== secret) {
      return json({ error: "Unauthorized" }, 401);
    }
  }
  const summary = await runAppointmentReminders();
  return json({ ok: true, ...summary });
}
