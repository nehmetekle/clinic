/**
 * Visit ownership: an unclosed consultation belongs to the doctor who opened it.
 * Test DB only (see run.sh).
 *
 * Dr John opens a visit; Dr Doe must not be able to edit it, close it, or delete
 * it — not through the UI (which hides the affordance) and not through a direct
 * API call, which is what this test exercises. An admin oversees every doctor and
 * may do all three. A visit with no doctor attached (legacy rows, or one started
 * without picking one) is unowned and stays workable by any clinical user —
 * locking those to an owner nobody has would strand them open forever.
 *
 * Also covers the read side: `listConsultations({ dietitianId })` is what backs
 * `?scope=mine`, so a doctor's "not closed" list can't even show another's visit.
 */
import { db } from "@/server/db";
import {
  closeConsultation,
  createConsultation,
  deleteConsultation,
  listConsultations,
  updateConsultation,
} from "@/server/repositories/consultations";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

async function expectFailure(label: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    ok(label, false, "expected a rejection, got success");
  } catch (e) {
    const message = (e as Error).message;
    ok(label, match ? match.test(message) : true, match ? `message: ${message}` : message);
  }
}

async function expectSuccess(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label, true);
  } catch (e) {
    ok(label, false, (e as Error).message);
  }
}

async function reset() {
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
}

async function main() {
  await reset();

  const john = await db.user.create({
    data: { fullName: "Dr John", email: "john@test.local", role: "dietitian", passwordHash: "x" },
  });
  const doe = await db.user.create({
    data: { fullName: "Dr Doe", email: "doe@test.local", role: "dietitian", passwordHash: "x" },
  });
  const admin = await db.user.create({
    data: { fullName: "Admin", email: "admin@test.local", role: "admin", passwordHash: "x" },
  });

  const JOHN = { actorName: john.fullName, actorEmail: john.email, actorRole: "dietitian" };
  const DOE = { actorName: doe.fullName, actorEmail: doe.email, actorRole: "dietitian" };
  const ADMIN = { actorName: admin.fullName, actorEmail: admin.email, actorRole: "admin" };

  const client = await db.client.create({
    data: { firstName: "Owned", lastName: "Patient", phone: "+96170123456" },
  });

  // A visit with nothing billable still raises a pending basket, which would
  // block close for its own (correct) reason. Clear it so this test only ever
  // fails on the ownership rule.
  const clearBasket = async (consultationId: string) => {
    await db.visitBasket.deleteMany({ where: { consultationId } });
  };
  // NB: there is one open visit per *client* — createConsultation returns the
  // existing draft rather than forking a second one — so anything that needs two
  // drafts alive at once must give each its own patient.
  const openVisit = async (dietitianId: string | null, forClientId = client.id) => {
    const c = await createConsultation({
      clientId: forClientId,
      dietitianId,
      waiveConsultationFee: true,
      notes: "draft",
    });
    await clearBasket(c.id);
    return c;
  };
  const makeClient = (n: number) =>
    db.client.create({
      data: { firstName: `Patient${n}`, lastName: "Scoped", phone: `+9617012345${n}` },
    });
  const edit = (id: string, opts: Record<string, unknown>, notes: string) =>
    updateConsultation(
      id,
      { clientId: client.id, waiveConsultationFee: true, notes },
      opts as never,
    );

  console.log("== another doctor is refused on every write path");
  const johnsVisit = await openVisit(john.id);

  await expectFailure(
    "Dr Doe cannot edit Dr John's open visit",
    () => edit(johnsVisit.id, DOE, "doe was here"),
    /another doctor/i,
  );
  await expectFailure(
    "Dr Doe cannot close Dr John's open visit",
    () => closeConsultation(johnsVisit.id, DOE),
    /another doctor/i,
  );
  await expectFailure(
    "Dr Doe cannot delete Dr John's open visit",
    () => deleteConsultation(johnsVisit.id, DOE),
    /another doctor/i,
  );

  // The refusals must be refusals, not partial writes.
  const untouched = await db.consultation.findUniqueOrThrow({ where: { id: johnsVisit.id } });
  ok(
    "the rejected writes left the visit exactly as it was",
    untouched.status === "open" && untouched.notes === "draft",
    `status=${untouched.status} notes=${untouched.notes}`,
  );

  console.log("== the owner works on it normally");
  await expectSuccess("Dr John can edit his own visit", () =>
    edit(johnsVisit.id, JOHN, "john's notes"),
  );
  await clearBasket(johnsVisit.id);
  await expectSuccess("Dr John can close his own visit", () =>
    closeConsultation(johnsVisit.id, JOHN),
  );
  ok(
    "closing actually took effect",
    (await db.consultation.findUniqueOrThrow({ where: { id: johnsVisit.id } })).status === "closed",
  );

  console.log("== admin oversees every doctor");
  const forAdminEdit = await openVisit(john.id);
  await expectSuccess("admin can edit another doctor's visit", () =>
    edit(forAdminEdit.id, ADMIN, "admin correction"),
  );
  await clearBasket(forAdminEdit.id);
  await expectSuccess("admin can close another doctor's visit", () =>
    closeConsultation(forAdminEdit.id, ADMIN),
  );

  const forAdminDelete = await openVisit(john.id);
  await expectSuccess("admin can delete another doctor's visit", () =>
    deleteConsultation(forAdminDelete.id, ADMIN),
  );
  ok(
    "the admin-deleted visit is gone",
    (await db.consultation.findUnique({ where: { id: forAdminDelete.id } })) === null,
  );

  console.log("== an unassigned visit is workable by anyone clinical");
  const orphan = await openVisit(null);
  await expectSuccess("any doctor can edit a visit with no doctor attached", () =>
    edit(orphan.id, DOE, "picked up by whoever is in"),
  );
  await clearBasket(orphan.id);
  await expectSuccess("any doctor can close a visit with no doctor attached", () =>
    closeConsultation(orphan.id, DOE),
  );

  const orphan2 = await openVisit(null);
  await expectSuccess("any doctor can delete a visit with no doctor attached", () =>
    deleteConsultation(orphan2.id, DOE),
  );

  console.log("== the read side is scoped too (?scope=mine)");
  // Three drafts alive at the same time, so three patients.
  const mine = await openVisit(john.id, (await makeClient(1)).id);
  const theirs = await openVisit(doe.id, (await makeClient(2)).id);
  const unowned = await openVisit(null, (await makeClient(3)).id);
  ok(
    "the three scoping fixtures really are three distinct visits",
    new Set([mine.id, theirs.id, unowned.id]).size === 3,
  );

  const johnsList = await listConsultations({ status: "open", dietitianId: john.id });
  const ids = johnsList.map((c) => c.id);
  ok("Dr John's scoped list contains his own open visit", ids.includes(mine.id));
  ok("Dr John's scoped list does NOT contain Dr Doe's visit", !ids.includes(theirs.id));
  ok("Dr John's scoped list still contains the unowned visit", ids.includes(unowned.id));

  const everything = (await listConsultations({ status: "open" })).map((c) => c.id);
  ok(
    "an unscoped list (what an admin gets) contains every open visit",
    [mine.id, theirs.id, unowned.id].every((id) => everything.includes(id)),
  );

  ok(
    "dietitianId is serialized, so the UI can match by id rather than by name",
    johnsList.find((c) => c.id === mine.id)?.dietitianId === john.id,
  );

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await db.$disconnect();
});
