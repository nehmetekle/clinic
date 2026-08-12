/**
 * #5 — "Close visit" double-clicked: two PATCH /api/consultations/[id] requests
 * with close:true, in flight at the same time. Replays exactly what that route
 * handler does (update → close → Food List catch-up).
 *
 * Expected after the fix: the second click never leaves the browser (client
 * guard), and even if it does, only ONE close's worth of audit entries + one
 * PDF results, with a human-readable message rather than a raw error.
 */
import { db } from "../../src/server/db";
import { closeConsultation, updateConsultation } from "../../src/server/repositories/consultations";
import { ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

/** The PATCH route handler's body, verbatim in shape. */
async function closeRequest(id: string, clientId: string) {
  await updateConsultation(id, { clientId, notes: "visit done", waiveConsultationFee: true }, {
    actorName: ACTOR.name,
    actorEmail: ACTOR.email,
  });
  const result = await closeConsultation(id, { actorName: ACTOR.name, actorEmail: ACTOR.email });
  await ensureFoodListPdf(id, ACTOR);
  return result;
}

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  // A visit fee makes the close audit-visible (discount/fee-waive logging).
  await db.consultation.update({
    where: { id: c.id },
    data: { consultationFee: 50 },
  });

  const results = await Promise.allSettled([
    closeRequest(c.id, client.id),
    closeRequest(c.id, client.id),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason));

  const audits = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  const closeAudits = audits.filter((a) => /waiv|discount/i.test(a.action));
  const pdfAudits = audits.filter((a) => /Food List PDF/i.test(a.action));
  const files = await db.consultationFile.count({ where: { consultationId: c.id } });

  console.log(`  ..    audit actions: ${audits.map((a) => a.action).join(" | ") || "none"}`);
  ok("exactly one close succeeds", fulfilled === 1, `${fulfilled} succeeded`);
  ok("one close-related audit entry", closeAudits.length === 1, `${closeAudits.length} entries`);
  ok("one PDF generation audit entry", pdfAudits.length === 1, `${pdfAudits.length} entries`);
  ok("exactly one Food List PDF attached", files === 1, `found ${files}`);
  ok(
    "loser (if any) gets a human-readable message",
    errors.every((m) => /already closed|no longer be edited/i.test(m)),
    errors.join(" | ") || "none",
  );
}

/**
 * The same double-click as the browser sees it: two clicks dispatched before
 * React can re-render and disable the button, on an already-saved visit.
 */
async function uiDoubleClick() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  await db.consultation.update({ where: { id: c.id }, data: { consultationFee: 50 } });

  let saving = false;
  let generatingPdf = false;
  const inFlight = { current: false };
  const toasts: string[] = [];
  const busy = () => saving || generatingPdf;

  // The editor's save(), close path only.
  async function save() {
    if (inFlight.current) return;
    inFlight.current = true;
    saving = true;
    try {
      await closeRequest(c.id, client.id);
      toasts.push("Visit closed");
    } catch (e) {
      toasts.push((e as Error).message);
    } finally {
      saving = false;
      inFlight.current = false;
    }
  }

  // Two clicks in the SAME tick: `busy` is still false for the second one
  // (React hasn't re-rendered), so only the synchronous ref can stop it.
  const clicks = [busy() ? null : save(), busy() ? null : save()];
  await Promise.all(clicks);

  const audits = await db.auditLog.findMany();
  const closeAudits = audits.filter((a) => /waiv|discount/i.test(a.action));
  const files = await db.consultationFile.count({ where: { consultationId: c.id } });
  console.log(`\n[UI double-click on "Close visit"]`);
  console.log(`  ..    toasts=${JSON.stringify(toasts)} audits=${audits.map((a) => a.action).join(" | ")}`);
  ok("one close audit entry", closeAudits.length === 1, `${closeAudits.length}`);
  ok("one Food List PDF", files === 1, `${files}`);
  ok("doctor sees a single 'Visit closed'", toasts.length === 1 && toasts[0] === "Visit closed", JSON.stringify(toasts));
}

main()
  .then(uiDoubleClick)
  .finally(() => db.$disconnect());
