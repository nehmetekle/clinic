/**
 * #24 — "Close visit" pressed from a LIST (Appointments & history), where there
 * is no editor form to send.
 *
 * The point of the close-only route (POST /api/consultations/[id]/close) is that
 * it must NOT go through updateConsultation: from a list the browser has no form
 * state, so an edit-then-close would rewrite the visit from an empty payload and
 * silently erase what the doctor recorded. This replays the route handler's body
 * verbatim and asserts:
 *   1. the visit's clinical data and charges survive the close untouched;
 *   2. an unsettled (pending) basket still blocks it — the V-close rule holds on
 *      this path too, and blocks BEFORE anything is written;
 *   3. another doctor's visit is refused (ownership), an admin's is not;
 *   4. a second close is refused readably;
 *   5. the Food List PDF catch-up still runs.
 */
import { db } from "../../src/server/db";
import { closeConsultation, updateConsultation } from "../../src/server/repositories/consultations";
import { ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

/** POST /api/consultations/[id]/close — the route handler's body, in shape. */
async function closeFromList(
  id: string,
  actor: { name: string; email: string; role?: string } = { ...ACTOR, role: "dietitian" },
) {
  const result = await closeConsultation(id, {
    actorName: actor.name,
    actorEmail: actor.email,
    actorRole: actor.role ?? "dietitian",
  });
  await ensureFoodListPdf(id, { name: actor.name, email: actor.email });
  return result;
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();

  // ---- 1. The recorded visit survives the close ------------------------------
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  await updateConsultation(
    c.id,
    { clientId: client.id, notes: "patient reports better sleep", weightKg: 81.5, goalWeightKg: 74 },
    { actorName: ACTOR.name, actorEmail: ACTOR.email },
  );
  await db.consultation.update({ where: { id: c.id }, data: { consultationFee: 50 } });
  // Whatever the save raised, settle it — this test is about the close, not billing.
  await db.visitBasket.updateMany({
    where: { consultationId: c.id, status: "pending" },
    data: { status: "paid", paidAt: new Date() },
  });

  await closeFromList(c.id);
  const closed = await db.consultation.findUniqueOrThrow({ where: { id: c.id } });
  ok("visit is closed", closed.status === "closed", closed.status);
  ok("closedAt stamped", closed.closedAt != null);
  ok("notes survive the close", closed.notes === "patient reports better sleep", `${closed.notes}`);
  ok("measurements survive the close", Number(closed.weightKg) === 81.5, `${closed.weightKg}`);
  ok("goal survives the close", Number(closed.goalWeightKg) === 74, `${closed.goalWeightKg}`);
  ok(
    "consultation fee survives the close",
    Number(closed.consultationFee) === 50,
    `${closed.consultationFee}`,
  );
  ok(
    "Food List PDF generated on close",
    (await db.consultationFile.count({ where: { consultationId: c.id } })) === 1,
  );

  // ---- 4. A second close is refused ------------------------------------------
  let reclosed = "";
  try {
    await closeFromList(c.id);
  } catch (e) {
    reclosed = message(e);
  }
  ok(
    "re-closing an already-closed visit is refused, readably",
    /already closed/i.test(reclosed),
    reclosed || "no error",
  );

  // ---- 2. A pending basket blocks the close, and writes nothing --------------
  const pendingVisit = await db.consultation.create({
    data: {
      clientId: client.id,
      dietitianId: doctor.id,
      date: new Date(),
      visitNumber: 2,
      status: "open",
    },
  });
  await db.visitBasket.create({
    data: {
      clientId: client.id,
      consultationId: pendingVisit.id,
      status: "pending",
      usdToLbp: 89000,
    },
  });
  let blocked = "";
  try {
    await closeFromList(pendingVisit.id);
  } catch (e) {
    blocked = message(e);
  }
  const stillOpen = await db.consultation.findUniqueOrThrow({ where: { id: pendingVisit.id } });
  ok("unsettled basket blocks the close", /settle this visit's basket/i.test(blocked), blocked || "no error");
  ok("blocked close leaves the visit open", stillOpen.status === "open" && stillOpen.closedAt === null);

  // ---- 3. Ownership ---------------------------------------------------------
  const other = await db.user.create({
    data: { fullName: "Dr Other", email: "other@test.local", role: "dietitian", passwordHash: "x" },
  });
  const theirs = await db.consultation.create({
    data: {
      clientId: client.id,
      dietitianId: other.id,
      date: new Date(),
      visitNumber: 3,
      status: "open",
    },
  });
  let refused = "";
  try {
    await closeFromList(theirs.id);
  } catch (e) {
    refused = message(e);
  }
  ok("another doctor's visit is refused", /belongs to another doctor/i.test(refused), refused || "no error");

  await closeFromList(theirs.id, { name: "The Admin", email: "admin@test.local", role: "admin" });
  ok(
    "an admin can close any doctor's visit",
    (await db.consultation.findUniqueOrThrow({ where: { id: theirs.id } })).status === "closed",
  );

  await db.$disconnect();
}

main();
