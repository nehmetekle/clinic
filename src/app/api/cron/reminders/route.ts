import { runAppointmentReminders } from "@/server/reminders";
import { json } from "@/server/http";
import { checkCronSecret } from "@/server/cron-auth";

// Hit by an external scheduler (cron-job.org) on a schedule to fire due reminders.
// Guarded by CRON_SECRET instead of a session — see server/cron-auth.ts, which
// accepts the secret as a Bearer header or a `?key=` param and, importantly,
// refuses the request outright when no secret is configured.
export async function GET(req: Request) {
  // Fails CLOSED: an unset CRON_SECRET disables the endpoint rather than
  // unlocking it, which is what the previous `if (secret)` shape did.
  const auth = checkCronSecret(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const summary = await runAppointmentReminders();
  return json({ ok: true, ...summary });
}
