/**
 * The close is all-or-nothing: the status flip, the audit entries and the
 * appointment/basket side effects share one transaction. Proven by forcing a
 * failure AFTER the status has been claimed — a trigger that rejects the audit
 * insert — and checking the visit is still open with nothing logged.
 */
import { db } from "../../src/server/db";
import { closeConsultation, updateConsultation } from "../../src/server/repositories/consultations";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  await db.consultation.update({ where: { id: c.id }, data: { consultationFee: 50 } });
  await updateConsultation(c.id, { clientId: client.id, waiveConsultationFee: true }, {
    actorName: ACTOR.name,
    actorEmail: ACTOR.email,
  });
  const auditsBefore = await db.auditLog.count();

  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION race_test_block_audit() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'race-test: audit write blocked'; END;
    $$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER race_test_block_audit BEFORE INSERT ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION race_test_block_audit();
  `);

  let threw = false;
  try {
    await closeConsultation(c.id, { actorName: ACTOR.name, actorEmail: ACTOR.email });
  } catch {
    threw = true;
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER race_test_block_audit ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION race_test_block_audit()`);
  }

  const after = await db.consultation.findUniqueOrThrow({ where: { id: c.id } });
  ok("the failing close is reported, not swallowed", threw);
  ok("status rolled back to open", after.status === "open", after.status);
  ok("closedAt rolled back to null", after.closedAt === null, String(after.closedAt));
  ok("no audit entry survived", (await db.auditLog.count()) === auditsBefore);

  // ...and the same visit still closes cleanly once the failure is gone.
  await closeConsultation(c.id, { actorName: ACTOR.name, actorEmail: ACTOR.email });
  const closed = await db.consultation.findUniqueOrThrow({ where: { id: c.id } });
  ok("closes normally afterwards", closed.status === "closed" && closed.closedAt !== null);
  ok(
    "and logs exactly one close entry",
    (await db.auditLog.count({ where: { action: "Consultation fee waived" } })) === 1,
  );
}

main().finally(() => db.$disconnect());
