/**
 * Machine-only visits: session accounting, billing, appointments, void, race
 * safety and authorization. Test DB only (see run.sh).
 *
 * Locks in the rules that make this feature safe to run at the front desk: a
 * machine visit is PURE CONSUMPTION — it draws only on sessions that have been
 * bought and settled, raises no basket and bills nothing; sessions that are
 * unbought (or sold but unsettled) are REFUSED rather than billed; nothing about
 * a consultation (fee, visit number, clinical row) is created; over-consumption
 * is refused rather than clamped; a replayed confirm consumes once; two desks
 * racing the last session produce exactly one visit; and a settled visit can't
 * be voided.
 */
import { db } from "@/server/db";
import {
  createMachineVisit,
  listMachineVisits,
  machineUtilization,
  voidMachineVisit,
} from "@/server/repositories/machineVisits";
import { createSessionPlan, sellSessions } from "@/server/repositories/sessionPlans";
import {
  closeConsultation,
  createConsultation,
  updateConsultation,
} from "@/server/repositories/consultations";
import { createSession, SESSION_COOKIE_NAME } from "@/server/session";
import { POST } from "@/app/api/machine-visits/route";
import { POST as VOID } from "@/app/api/machine-visits/[id]/void/route";
import { listVisitBaskets, settleVisitBasket } from "@/server/repositories/visitBaskets";
import type { MachineVisitActor } from "@/server/repositories/machineVisits";

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

async function reset() {
  await db.auditLog.deleteMany({});
  await db.machineVisit.deleteMany({});
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.package.deleteMany({});
}

async function main() {
  await reset();

  const doc = await db.user.create({
    data: { fullName: "Dr M", email: "m@test.local", role: "dietitian", passwordHash: "x", consultationFee: 50 },
  });
  const other = await db.user.create({
    data: { fullName: "Dr O", email: "o@test.local", role: "dietitian", passwordHash: "x", consultationFee: 50 },
  });
  const actor: MachineVisitActor = { id: doc.id, name: doc.fullName, role: "dietitian" };
  const otherActor: MachineVisitActor = { id: other.id, name: other.fullName, role: "dietitian" };
  const admin: MachineVisitActor = { id: null, name: "Admin", role: "admin" };

  const client = await db.client.create({
    data: { firstName: "Mac", lastName: "Hine", phone: "+96170123456" },
  });
  const client2 = await db.client.create({
    data: { firstName: "Other", lastName: "Patient", phone: "+96170123457" },
  });
  await db.servicePrice.create({
    data: { kind: "treatment", key: "RF Body", name: "RF Body", price: 10, currency: "USD", active: true },
  });
  await db.servicePrice.create({
    data: { kind: "treatment", key: "Cavitation", name: "Cavitation", price: 20, currency: "USD", active: true },
  });

  // =====================================================================
  // 1. Fully prepaid plan: consume 2 of 12 credit, bill nothing
  // =====================================================================
  const plan = await createSessionPlan({ clientId: client.id, machine: "RF Body", sessionsNeeded: 13 });
  const v1 = await createConsultation({
    clientId: client.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "RF Body", sessionsNeeded: 13, sessionsUsed: 1, sessionPlanId: plan.id }],
  });
  let baskets = await listVisitBaskets({ clientId: client.id, status: "pending" });
  await settleVisitBasket(baskets[0].id, { splits: [{ method: "cash", amount: 130 }], actorName: "Sec" });
  await db.consultation.update({ where: { id: v1.id }, data: { status: "closed" } });

  let p = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  ok("setup: 13 paid / 1 used / 12 credit", p.sessionsPaid === 13 && p.sessionsUsed === 1,
     `paid=${p.sessionsPaid} used=${p.sessionsUsed}`);

  const consultationsBefore = await db.consultation.count();
  const paymentsBefore = await db.payment.count();

  const mv1 = await createMachineVisit(
    { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 2 }] },
    actor,
  );
  p = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  ok("prepaid: used 1 -> 3", p.sessionsUsed === 3, `used=${p.sessionsUsed}`);
  ok("prepaid: remaining credit 10", p.sessionsPaid - p.sessionsUsed === 10,
     `credit=${p.sessionsPaid - p.sessionsUsed}`);
  ok("prepaid: nothing billed", mv1.amountDue === 0, `amountDue=${mv1.amountDue}`);
  ok("prepaid: no basket raised",
     (await db.visitBasket.count({ where: { machineVisitId: mv1.id } })) === 0);
  ok("prepaid: no consultation created", (await db.consultation.count()) === consultationsBefore);
  ok("prepaid: no payment created", (await db.payment.count()) === paymentsBefore);
  ok("prepaid: no consultation fee anywhere",
     (await db.visitBasketItem.count({ where: { kind: "consultation_fee" } })) === 0);
  ok("prepaid: visit is in history", (await listMachineVisits({ clientId: client.id })).length === 1);
  ok("prepaid: actor recorded from the session", mv1.recordedByName === "Dr M");

  // =====================================================================
  // 2. Multiple machines in one visit
  // =====================================================================
  const cav = await createSessionPlan({ clientId: client.id, machine: "Cavitation", sessionsNeeded: 4 });
  const cavConsult = await createConsultation({
    clientId: client.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "Cavitation", sessionsNeeded: 4, sessionsUsed: 0, sessionPlanId: cav.id }],
  });
  baskets = await listVisitBaskets({ clientId: client.id, status: "pending" });
  await settleVisitBasket(baskets[0].id, { splits: [{ method: "cash", amount: 80 }], actorName: "Sec" });
  await db.consultation.update({ where: { id: cavConsult.id }, data: { status: "closed" } });

  const mv2 = await createMachineVisit(
    {
      clientId: client.id,
      items: [
        { sessionPlanId: plan.id, sessions: 1 },
        { sessionPlanId: cav.id, sessions: 2 },
      ],
      note: "Both machines",
    },
    actor,
  );
  const rf = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  const cv = await db.sessionPlan.findUniqueOrThrow({ where: { id: cav.id } });
  ok("multi-machine: one visit, two lines", mv2.items.length === 2);
  ok("multi-machine: RF used 4", rf.sessionsUsed === 4, `used=${rf.sessionsUsed}`);
  ok("multi-machine: Cavitation used 2", cv.sessionsUsed === 2, `used=${cv.sessionsUsed}`);
  ok("multi-machine: still nothing billed", mv2.amountDue === 0);

  // A source may only appear once per visit (two lines would each price
  // themselves against the same credit).
  await expectFailure(
    "duplicate source in one visit is refused",
    () =>
      createMachineVisit(
        {
          clientId: client.id,
          items: [
            { sessionPlanId: plan.id, sessions: 1 },
            { sessionPlanId: plan.id, sessions: 1 },
          ],
        },
        actor,
      ),
    /only be logged once/i,
  );

  // =====================================================================
  // 3. Bundle (ClientPackage) consumption + insufficient balance refused
  // =====================================================================
  const bundle = await db.clientPackage.create({
    data: {
      clientId: client.id,
      packageName: "RF 15",
      price: 140,
      currency: "USD",
      totalSessions: 15,
      usedSessions: 14, // 1 left
      machine: "RF Body",
      status: "active",
    },
  });
  await expectFailure(
    "bundle: asking for 3 when 1 remains is REFUSED (not clamped)",
    () =>
      createMachineVisit(
        { clientId: client.id, items: [{ clientPackageId: bundle.id, sessions: 3 }] },
        actor,
      ),
    /Only 1 session left/i,
  );
  const afterRefusal = await db.clientPackage.findUniqueOrThrow({ where: { id: bundle.id } });
  ok("bundle: refused attempt consumed nothing", afterRefusal.usedSessions === 14,
     `used=${afterRefusal.usedSessions}`);

  const mvBundle = await createMachineVisit(
    { clientId: client.id, items: [{ clientPackageId: bundle.id, sessions: 1 }] },
    actor,
  );
  const bundleAfter = await db.clientPackage.findUniqueOrThrow({ where: { id: bundle.id } });
  ok("bundle: 1 session consumed", bundleAfter.usedSessions === 15, `used=${bundleAfter.usedSessions}`);
  ok("bundle: status completed at full usage", bundleAfter.status === "completed", bundleAfter.status);
  ok("bundle: never billed", mvBundle.amountDue === 0);

  // =====================================================================
  // 4. Unsettled sessions are REFUSED — a machine visit never bills
  // =====================================================================
  const client3 = await db.client.create({
    data: { firstName: "Un", lastName: "Paid", phone: "+96170123458" },
  });
  const plan3 = await createSessionPlan({ clientId: client3.id, machine: "RF Body", sessionsNeeded: 13 });
  // 10 bought and settled, all 10 used -> nothing available, though the course
  // still calls for 3 more sessions nobody has bought.
  await db.sessionPlan.update({
    where: { id: plan3.id },
    data: { sessionsPaid: 10, sessionsUsed: 10 },
  });

  await expectFailure(
    "no availability: the visit is refused, not billed",
    () =>
      createMachineVisit(
        { clientId: client3.id, items: [{ sessionPlanId: plan3.id, sessions: 2 }] },
        actor,
      ),
    /0 sessions available/i,
  );
  const p3Refused = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan3.id } });
  ok("no availability: nothing consumed", p3Refused.sessionsUsed === 10, `used=${p3Refused.sessionsUsed}`);
  ok("no availability: plan not enlarged", p3Refused.sessionsNeeded === 13, `needed=${p3Refused.sessionsNeeded}`);
  ok("no availability: NO basket raised",
     (await listVisitBaskets({ clientId: client3.id, status: "pending" })).length === 0);
  ok("no availability: no machine visit recorded",
     (await db.machineVisit.count({ where: { clientId: client3.id } })) === 0);
  ok("no availability: no payment", (await db.payment.count({ where: { clientId: client3.id } })) === 0);

  // The prescribed-but-unbought sessions are sold the normal way, and SETTLING
  // that sale is what makes them usable.
  const sale3 = await sellSessions(
    { clientId: client3.id, machine: "RF Body", sessions: 2 },
    { id: doc.id, name: doc.fullName },
  );
  ok("sale: pending basket raised at the plan's own price",
     (await listVisitBaskets({ clientId: client3.id, status: "pending" }))[0]?.total === 20,
     `total=${(await listVisitBaskets({ clientId: client3.id, status: "pending" }))[0]?.total}`);
  await expectFailure(
    "sold but UNSETTLED unlocks nothing",
    () =>
      createMachineVisit(
        { clientId: client3.id, items: [{ sessionPlanId: plan3.id, sessions: 1 }] },
        actor,
      ),
    /0 sessions available/i,
  );

  await settleVisitBasket(sale3.basketId, { splits: [{ method: "cash", amount: 20 }], actorName: "Sec" });
  const p3Settled = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan3.id } });
  ok("settlement unlocks: sessionsPaid 10 -> 12", p3Settled.sessionsPaid === 12, `paid=${p3Settled.sessionsPaid}`);
  ok("settlement produced a real payment",
     (await db.payment.count({ where: { clientId: client3.id } })) === 1);

  const mv3 = await createMachineVisit(
    { clientId: client3.id, items: [{ sessionPlanId: plan3.id, sessions: 2 }] },
    actor,
  );
  const p3Used = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan3.id } });
  ok("settled sessions are consumable", p3Used.sessionsUsed === 12, `used=${p3Used.sessionsUsed}`);
  ok("consuming them bills nothing", mv3.amountDue === 0, `amountDue=${mv3.amountDue}`);
  ok("consuming them raises no basket",
     (await listVisitBaskets({ clientId: client3.id, status: "pending" })).length === 0);

  // =====================================================================
  // 5. A machine visit can never draw past what is available
  // =====================================================================
  await expectFailure(
    "cannot consume past what is available",
    () =>
      createMachineVisit(
        { clientId: client3.id, items: [{ sessionPlanId: plan3.id, sessions: 5 }] },
        actor,
      ),
    /available/i,
  );
  const p3Final = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan3.id } });
  ok("available never goes negative",
     p3Final.sessionsPaid - p3Final.sessionsUsed >= 0,
     `paid=${p3Final.sessionsPaid} used=${p3Final.sessionsUsed}`);

  // =====================================================================
  // 6. IDOR: another client's plan / another patient's appointment
  // =====================================================================
  await expectFailure(
    "IDOR: client B cannot spend client A's plan",
    () =>
      createMachineVisit(
        { clientId: client2.id, items: [{ sessionPlanId: plan.id, sessions: 1 }] },
        actor,
      ),
    /not found for this patient/i,
  );
  await expectFailure(
    "IDOR: client B cannot spend client A's bundle",
    () =>
      createMachineVisit(
        { clientId: client2.id, items: [{ clientPackageId: bundle.id, sessions: 1 }] },
        actor,
      ),
    /not found for this patient/i,
  );

  // =====================================================================
  // 7. Appointments
  // =====================================================================
  const apptToday = await db.appointment.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), time: "10:30", status: "checked_in" },
  });
  const apptOther = await db.appointment.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), time: "15:00", status: "scheduled" },
  });
  const foreignAppt = await db.appointment.create({
    data: { clientId: client2.id, dietitianId: doc.id, date: new Date(), time: "11:00", status: "checked_in" },
  });

  await expectFailure(
    "appointment: another patient's appointment is refused",
    () =>
      createMachineVisit(
        { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }], appointmentId: foreignAppt.id },
        actor,
      ),
    /belongs to another patient/i,
  );

  const mvAppt = await createMachineVisit(
    {
      clientId: client.id,
      items: [{ sessionPlanId: plan.id, sessions: 1 }],
      appointmentId: apptToday.id,
    },
    actor,
  );
  const apptAfter = await db.appointment.findUniqueOrThrow({ where: { id: apptToday.id } });
  const apptOtherAfter = await db.appointment.findUniqueOrThrow({ where: { id: apptOther.id } });
  const foreignAfter = await db.appointment.findUniqueOrThrow({ where: { id: foreignAppt.id } });
  ok("appointment: the explicit one is completed", apptAfter.status === "completed", apptAfter.status);
  ok("appointment: linked on the visit", mvAppt.appointmentId === apptToday.id);
  ok("appointment: the patient's other booking is untouched", apptOtherAfter.status === "scheduled",
     apptOtherAfter.status);
  ok("appointment: another patient's booking is untouched", foreignAfter.status === "checked_in",
     foreignAfter.status);

  // Ambiguity: two live appointments and no explicit id -> complete neither.
  const amb1 = await db.appointment.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), time: "16:00", status: "checked_in" },
  });
  const amb2 = await db.appointment.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), time: "16:30", status: "with_dietitian" },
  });
  const mvAmb = await createMachineVisit(
    { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }] },
    actor,
  );
  ok("appointment: ambiguous candidates leave the visit unlinked", !mvAmb.appointmentId);
  ok("appointment: neither ambiguous booking was completed",
     (await db.appointment.findUniqueOrThrow({ where: { id: amb1.id } })).status === "checked_in" &&
       (await db.appointment.findUniqueOrThrow({ where: { id: amb2.id } })).status === "with_dietitian");
  await db.appointment.deleteMany({ where: { id: { in: [amb1.id, amb2.id] } } });

  // Exactly one live candidate -> completed automatically.
  const solo = await db.appointment.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), time: "17:00", status: "checked_in" },
  });
  const mvSolo = await createMachineVisit(
    { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }] },
    actor,
  );
  ok("appointment: the single live booking is completed automatically",
     mvSolo.appointmentId === solo.id &&
       (await db.appointment.findUniqueOrThrow({ where: { id: solo.id } })).status === "completed");

  // =====================================================================
  // 8. Idempotency — a replayed confirm consumes once
  // =====================================================================
  const key = "idem-test-key-0001";
  const usedBefore = (await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } })).sessionsUsed;
  const a = await createMachineVisit(
    { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }], idempotencyKey: key },
    actor,
  );
  const b = await createMachineVisit(
    { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }], idempotencyKey: key },
    actor,
  );
  const usedAfter = (await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } })).sessionsUsed;
  ok("idempotency: replay returns the same visit", a.id === b.id, `${a.id} vs ${b.id}`);
  ok("idempotency: replay consumed once", usedAfter === usedBefore + 1,
     `${usedBefore} -> ${usedAfter}`);

  // Concurrent replay (the double-clicked button) settles on the unique key.
  const key2 = "idem-test-key-0002";
  const usedBefore2 = (await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } })).sessionsUsed;
  const both = await Promise.allSettled([
    createMachineVisit(
      { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }], idempotencyKey: key2 },
      actor,
    ),
    createMachineVisit(
      { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }], idempotencyKey: key2 },
      actor,
    ),
  ]);
  const usedAfter2 = (await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } })).sessionsUsed;
  const createdIds = new Set(
    both.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id),
  );
  ok("idempotency: concurrent replay consumed once", usedAfter2 === usedBefore2 + 1,
     `${usedBefore2} -> ${usedAfter2}`);
  ok("idempotency: concurrent replay yielded one visit", createdIds.size === 1,
     `${createdIds.size} distinct id(s)`);

  // =====================================================================
  // 9. Concurrency — two desks, one session left
  // =====================================================================
  const raceClient = await db.client.create({
    data: { firstName: "Race", lastName: "Last", phone: "+96170123459" },
  });
  const racePlan = await createSessionPlan({
    clientId: raceClient.id,
    machine: "RF Body",
    sessionsNeeded: 5,
  });
  // 5 paid, 4 used -> exactly ONE session left.
  await db.sessionPlan.update({
    where: { id: racePlan.id },
    data: { sessionsPaid: 5, sessionsUsed: 4 },
  });
  const raced = await Promise.allSettled([
    createMachineVisit(
      { clientId: raceClient.id, items: [{ sessionPlanId: racePlan.id, sessions: 1 }] },
      actor,
    ),
    createMachineVisit(
      { clientId: raceClient.id, items: [{ sessionPlanId: racePlan.id, sessions: 1 }] },
      actor,
    ),
  ]);
  const winners = raced.filter((r) => r.status === "fulfilled").length;
  const racedPlan = await db.sessionPlan.findUniqueOrThrow({ where: { id: racePlan.id } });
  ok("race: exactly one of two concurrent logs succeeds", winners === 1, `${winners} succeeded`);
  ok("race: plan lands on 5 used, never 6", racedPlan.sessionsUsed === 5,
     `used=${racedPlan.sessionsUsed}`);
  ok("race: never negative remaining", racedPlan.sessionsNeeded - racedPlan.sessionsUsed >= 0);
  ok("race: only one visit exists",
     (await db.machineVisit.count({ where: { clientId: raceClient.id } })) === 1);

  // =====================================================================
  // 10. Void
  // =====================================================================
  const voidClient = await db.client.create({
    data: { firstName: "Void", lastName: "Case", phone: "+96170123460" },
  });
  const voidPlan = await createSessionPlan({
    clientId: voidClient.id,
    machine: "RF Body",
    sessionsNeeded: 10,
  });
  await db.sessionPlan.update({
    where: { id: voidPlan.id },
    data: { sessionsPaid: 10, sessionsUsed: 2 },
  });
  const toVoid = await createMachineVisit(
    { clientId: voidClient.id, items: [{ sessionPlanId: voidPlan.id, sessions: 2 }] },
    actor,
  );
  ok("void: prepaid visit consumed 2", 
     (await db.sessionPlan.findUniqueOrThrow({ where: { id: voidPlan.id } })).sessionsUsed === 4);

  await expectFailure(
    "void: another doctor cannot void someone else's visit",
    () => voidMachineVisit(toVoid.id, {}, otherActor),
    /only void a machine visit you recorded/i,
  );

  const voided = await voidMachineVisit(toVoid.id, { reason: "Logged twice" }, actor);
  const voidPlanAfter = await db.sessionPlan.findUniqueOrThrow({ where: { id: voidPlan.id } });
  ok("void: sessions restored exactly", voidPlanAfter.sessionsUsed === 2,
     `used=${voidPlanAfter.sessionsUsed}`);
  ok("void: visit stays in history as voided", voided.status === "voided");
  ok("void: attribution kept", voided.voidedByName === "Dr M" && voided.voidReason === "Logged twice");
  ok("void: row is not deleted",
     (await db.machineVisit.count({ where: { id: toVoid.id } })) === 1);
  await expectFailure(
    "void: voiding twice is refused",
    () => voidMachineVisit(toVoid.id, {}, admin),
    /already voided/i,
  );

  // A void never has a basket to clean up any more — it only gives sessions back.
  const unpaidClient = await db.client.create({
    data: { firstName: "Unsettled", lastName: "Void", phone: "+96170123461" },
  });
  const unpaidPlan = await createSessionPlan({
    clientId: unpaidClient.id,
    machine: "RF Body",
    sessionsNeeded: 6,
  });
  await db.sessionPlan.update({ where: { id: unpaidPlan.id }, data: { sessionsPaid: 6 } });
  const consumedVisit = await createMachineVisit(
    { clientId: unpaidClient.id, items: [{ sessionPlanId: unpaidPlan.id, sessions: 2 }] },
    actor,
  );
  ok("void: the visit charged nothing", consumedVisit.amountDue === 0, `amountDue=${consumedVisit.amountDue}`);
  ok("void: no basket exists to clean up",
     (await db.visitBasket.count({ where: { machineVisitId: consumedVisit.id } })) === 0);
  await voidMachineVisit(consumedVisit.id, { reason: "Wrong patient" }, actor);
  ok("void: sessions restored",
     (await db.sessionPlan.findUniqueOrThrow({ where: { id: unpaidPlan.id } })).sessionsUsed === 0);

  // A settled basket still blocks a void. Current visits raise none, so this
  // covers the HISTORIC rows that predate purchase and consumption being split:
  // the guard has to keep holding for them (no refunds, ever).
  const settledClient = await db.client.create({
    data: { firstName: "Settled", lastName: "Void", phone: "+96170123462" },
  });
  const settledPlan = await createSessionPlan({
    clientId: settledClient.id,
    machine: "RF Body",
    sessionsNeeded: 6,
  });
  await db.sessionPlan.update({ where: { id: settledPlan.id }, data: { sessionsPaid: 6 } });
  const settledVisit = await createMachineVisit(
    { clientId: settledClient.id, items: [{ sessionPlanId: settledPlan.id, sessions: 1 }] },
    actor,
  );
  // Stand in for a legacy machine-visit basket that was collected on.
  await db.visitBasket.create({
    data: {
      clientId: settledClient.id,
      machineVisitId: settledVisit.id,
      status: "paid",
      currency: "USD",
      usdToLbp: 89000,
      paidAt: new Date(),
    },
  });
  await expectFailure(
    "void: a settled machine visit cannot be voided",
    () => voidMachineVisit(settledVisit.id, { reason: "oops" }, admin),
    /paid for and can't be voided/i,
  );
  ok("void: refused void left the sessions consumed",
     (await db.sessionPlan.findUniqueOrThrow({ where: { id: settledPlan.id } })).sessionsUsed === 1);

  // =====================================================================
  // 11. Database constraints (the last line of defence)
  // =====================================================================
  await expectFailure(
    "db: a machine visit item with no source is rejected",
    () =>
      db.$executeRawUnsafe(
        `INSERT INTO "MachineVisitItem" ("id","machineVisitId","machine","sessions") VALUES ('bad1', '${mv1.id}', 'RF Body', 1)`,
      ),
    /MachineVisitItem_one_source|violates check constraint/i,
  );
  await expectFailure(
    "db: zero sessions is rejected",
    () =>
      db.$executeRawUnsafe(
        `INSERT INTO "MachineVisitItem" ("id","machineVisitId","machine","sessions","sessionPlanId") VALUES ('bad2', '${mv1.id}', 'RF Body', 0, '${plan.id}')`,
      ),
    /sessions_positive|violates check constraint/i,
  );
  await expectFailure(
    "db: negative sessionsUsed is rejected",
    () => db.$executeRawUnsafe(`UPDATE "SessionPlan" SET "sessionsUsed" = -1 WHERE id = '${plan.id}'`),
    /counts_non_negative|violates check constraint/i,
  );
  await expectFailure(
    "db: a bundle used beyond its total is rejected",
    () =>
      db.$executeRawUnsafe(
        `UPDATE "ClientPackage" SET "usedSessions" = "totalSessions" + 1 WHERE id = '${bundle.id}'`,
      ),
    /sessions_within_total|violates check constraint/i,
  );

  // =====================================================================
  // 12. Route authorization — the real gate, not the hidden button
  // =====================================================================
  {
    const secretary = await db.user.create({
      data: { fullName: "Front Desk", email: "sec@test.local", role: "secretary", passwordHash: "x" },
    });
    const secretaryToken = await createSession(secretary.id);
    const doctorToken = await createSession(doc.id);
    const post = (token: string | null, body: unknown) =>
      POST(
        new Request("http://localhost/api/machine-visits", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );

    const anon = await post(null, { clientId: client.id, items: [{ sessionPlanId: plan.id, sessions: 1 }] });
    ok("auth: no session is rejected", anon.status === 403, `status=${anon.status}`);

    const sec = await post(secretaryToken, {
      clientId: client.id,
      items: [{ sessionPlanId: plan.id, sessions: 1 }],
    });
    ok("auth: secretary POST is rejected server-side", sec.status === 403, `status=${sec.status}`);

    const priceForged = await post(doctorToken, {
      clientId: client.id,
      items: [{ sessionPlanId: plan.id, sessions: 1, unitPrice: 0, billedSessions: 0 }],
      recordedByName: "Someone Else",
    });
    ok("auth: doctor POST is accepted", priceForged.status === 201, `status=${priceForged.status}`);
    const forged = (await priceForged.json()) as { recordedByName: string; items: { unitPrice: number }[] };
    ok("auth: a forged actor name in the payload is ignored", forged.recordedByName === "Dr M",
       forged.recordedByName);
    ok("auth: a client-supplied price is ignored (plan's own $10 used)",
       forged.items[0]?.unitPrice === 10, `unitPrice=${forged.items[0]?.unitPrice}`);

    const badVoid = await VOID(
      new Request("http://localhost/api/machine-visits/x/void", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${secretaryToken}` },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: toVoid.id }) },
    );
    ok("auth: secretary cannot void", badVoid.status === 403, `status=${badVoid.status}`);
  }

  // =====================================================================
  // 13. Existing consultation path: concurrent saves of one draft
  // =====================================================================
  {
    const cClient = await db.client.create({
      data: { firstName: "Concurrent", lastName: "Draft", phone: "+96170123463" },
    });
    const cPlan = await createSessionPlan({
      clientId: cClient.id,
      machine: "RF Body",
      sessionsNeeded: 8,
    });
    const draft = await createConsultation({
      clientId: cClient.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      treatments: [{ machine: "RF Body", sessionsNeeded: 8, sessionsUsed: 1, sessionPlanId: cPlan.id }],
    });
    const payload = {
      clientId: cClient.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      treatments: [
        { machine: "RF Body", sessionsNeeded: 8, sessionsUsed: 2, sessionPlanId: cPlan.id },
      ],
    };
    // Two tabs saving the same draft at once. Whatever order they land in, the
    // plan must end up reflecting the payload once — never twice.
    const saves = await Promise.allSettled([
      updateConsultation(draft.id, payload, {}),
      updateConsultation(draft.id, payload, {}),
    ]);
    const succeeded = saves.filter((r) => r.status === "fulfilled").length;
    const cPlanAfter = await db.sessionPlan.findUniqueOrThrow({ where: { id: cPlan.id } });
    ok("consultation: concurrent saves of one draft don't double-count",
       cPlanAfter.sessionsUsed === 2, `used=${cPlanAfter.sessionsUsed} (${succeeded} save(s) landed)`);
    ok("consultation: usage never negative", cPlanAfter.sessionsUsed >= 0);
  }

  // =====================================================================
  // 14. Consultations complete ONLY their own appointment
  // =====================================================================
  {
    const cc = await db.client.create({
      data: { firstName: "Appt", lastName: "Exact", phone: "+96170123464" },
    });

    // -- one appointment: the common case still works, linked or not.
    const soloAppt = await db.appointment.create({
      data: { clientId: cc.id, dietitianId: doc.id, date: new Date(), time: "09:00", status: "checked_in" },
    });
    const soloVisit = await createConsultation(
      { clientId: cc.id, dietitianId: doc.id, waiveConsultationFee: true },
      { close: true },
    );
    ok("consultation appt: the single live booking is completed (unlinked visit)",
       (await db.appointment.findUniqueOrThrow({ where: { id: soloAppt.id } })).status === "completed");
    ok("consultation appt: single-booking close still finalizes the visit",
       soloVisit.status === "closed", soloVisit.status);

    // -- several appointments: only the linked one closes.
    const target = await db.appointment.create({
      data: { clientId: cc.id, dietitianId: doc.id, date: new Date(), time: "10:00", status: "checked_in" },
    });
    const bystander = await db.appointment.create({
      data: { clientId: cc.id, dietitianId: doc.id, date: new Date(), time: "14:00", status: "with_dietitian" },
    });
    const scheduledLater = await db.appointment.create({
      data: { clientId: cc.id, dietitianId: doc.id, date: new Date(), time: "16:00", status: "scheduled" },
    });
    const linkedVisit = await createConsultation(
      {
        clientId: cc.id,
        dietitianId: doc.id,
        waiveConsultationFee: true,
        appointmentId: target.id,
      },
      { close: true },
    );
    ok("consultation appt: the linked booking is completed",
       (await db.appointment.findUniqueOrThrow({ where: { id: target.id } })).status === "completed");
    ok("consultation appt: the patient's other live booking is UNTOUCHED",
       (await db.appointment.findUniqueOrThrow({ where: { id: bystander.id } })).status === "with_dietitian");
    ok("consultation appt: a later scheduled booking is UNTOUCHED",
       (await db.appointment.findUniqueOrThrow({ where: { id: scheduledLater.id } })).status === "scheduled");
    ok("consultation appt: the link is persisted on the visit",
       (await db.consultation.findUniqueOrThrow({ where: { id: linkedVisit.id } })).appointmentId === target.id);

    // -- ambiguous and unlinked: complete none rather than guess. `bystander` is
    // still live, so a second live booking makes the choice genuinely ambiguous
    // (a `scheduled` one is not a candidate — the patient hasn't arrived for it).
    const secondLive = await db.appointment.create({
      data: { clientId: cc.id, dietitianId: doc.id, date: new Date(), time: "11:30", status: "checked_in" },
    });
    const amb = await createConsultation(
      { clientId: cc.id, dietitianId: doc.id, waiveConsultationFee: true },
      { close: true },
    );
    ok("consultation appt: ambiguous + unlinked completes nothing",
       (await db.appointment.findUniqueOrThrow({ where: { id: bystander.id } })).status === "with_dietitian" &&
         (await db.appointment.findUniqueOrThrow({ where: { id: secondLive.id } })).status === "checked_in" &&
         (await db.appointment.findUniqueOrThrow({ where: { id: scheduledLater.id } })).status === "scheduled",
       `visit ${amb.status}`);

    // -- another patient's appointment can't be linked (IDOR).
    const foreign = await db.appointment.create({
      data: { clientId: client2.id, dietitianId: doc.id, date: new Date(), time: "12:00", status: "checked_in" },
    });
    await expectFailure(
      "consultation appt: another patient's appointment is refused",
      () =>
        createConsultation({
          clientId: cc.id,
          dietitianId: doc.id,
          waiveConsultationFee: true,
          appointmentId: foreign.id,
        }),
      /belongs to another patient/i,
    );
    ok("consultation appt: the foreign booking is untouched",
       (await db.appointment.findUniqueOrThrow({ where: { id: foreign.id } })).status === "checked_in");

    // -- a draft started without a booking adopts one when continued from the queue.
    const adoptClient = await db.client.create({
      data: { firstName: "Adopt", lastName: "Link", phone: "+96170123465" },
    });
    const adoptA = await db.appointment.create({
      data: { clientId: adoptClient.id, dietitianId: doc.id, date: new Date(), time: "09:30", status: "checked_in" },
    });
    const adoptB = await db.appointment.create({
      data: { clientId: adoptClient.id, dietitianId: doc.id, date: new Date(), time: "13:30", status: "checked_in" },
    });
    const draft = await createConsultation({
      clientId: adoptClient.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
    });
    await updateConsultation(
      draft.id,
      {
        clientId: adoptClient.id,
        dietitianId: doc.id,
        waiveConsultationFee: true,
        appointmentId: adoptB.id,
      },
      {},
    );
    await closeConsultation(draft.id, {});
    ok("consultation appt: a continued draft adopts the booking it was worked from",
       (await db.appointment.findUniqueOrThrow({ where: { id: adoptB.id } })).status === "completed");
    ok("consultation appt: the adopted link left the other booking alone",
       (await db.appointment.findUniqueOrThrow({ where: { id: adoptA.id } })).status === "checked_in");
  }

  // =====================================================================
  // 15. Machine utilization counts CLOSED consultations only
  // =====================================================================
  {
    const uClient = await db.client.create({
      data: { firstName: "Util", lastName: "Report", phone: "+96170123466" },
    });
    const uPlan = await createSessionPlan({
      clientId: uClient.id,
      machine: "Cavitation",
      sessionsNeeded: 10,
    });
    await db.sessionPlan.update({
      where: { id: uPlan.id },
      data: { sessionsPaid: 10, sessionsUsed: 0 },
    });
    const before = (await machineUtilization({})).find((u) => u.machine === "Cavitation");

    // An OPEN draft consuming 3 sessions: real balance movement, no report movement.
    const openDraft = await createConsultation({
      clientId: uClient.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      treatments: [{ machine: "Cavitation", sessionsNeeded: 10, sessionsUsed: 3, sessionPlanId: uPlan.id }],
    });
    const midPlan = await db.sessionPlan.findUniqueOrThrow({ where: { id: uPlan.id } });
    const during = (await machineUtilization({})).find((u) => u.machine === "Cavitation");
    ok("utilization: an open draft still consumes the plan balance", midPlan.sessionsUsed === 3,
       `used=${midPlan.sessionsUsed}`);
    ok("utilization: an open draft is NOT reported",
       (during?.consultationSessions ?? 0) === (before?.consultationSessions ?? 0),
       `${before?.consultationSessions} -> ${during?.consultationSessions}`);

    await closeConsultation(openDraft.id, {});
    const after = (await machineUtilization({})).find((u) => u.machine === "Cavitation");
    ok("utilization: closing the visit reports its 3 sessions",
       (after?.consultationSessions ?? 0) === (before?.consultationSessions ?? 0) + 3,
       `${before?.consultationSessions} -> ${after?.consultationSessions}`);

    // The plan stays usable afterwards, by both paths — the reporting rule
    // changes nothing about balances.
    const mvAfter = await createMachineVisit(
      { clientId: uClient.id, items: [{ sessionPlanId: uPlan.id, sessions: 1 }] },
      actor,
    );
    ok("utilization: a machine visit can still draw on that plan", mvAfter.amountDue === 0);
    const nextConsult = await createConsultation({
      clientId: uClient.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      treatments: [{ machine: "Cavitation", sessionsNeeded: 10, sessionsUsed: 2, sessionPlanId: uPlan.id }],
    });
    await closeConsultation(nextConsult.id, {});
    const finalPlan = await db.sessionPlan.findUniqueOrThrow({ where: { id: uPlan.id } });
    ok("utilization: plan keeps working across both paths (3 + 1 + 2 = 6 used)",
       finalPlan.sessionsUsed === 6, `used=${finalPlan.sessionsUsed}`);
    ok("utilization: prepaid credit unaffected by the reporting rule",
       finalPlan.sessionsPaid - finalPlan.sessionsUsed === 4,
       `credit=${finalPlan.sessionsPaid - finalPlan.sessionsUsed}`);
    const machineVisitOnly = (await machineUtilization({})).find((u) => u.machine === "Cavitation");
    ok("utilization: machine visits are reported immediately (no close step)",
       (machineVisitOnly?.sessions ?? 0) >= 6);
  }

  // =====================================================================
  // 16. Reporting
  // =====================================================================
  const usage = await machineUtilization({});
  const rfRow = usage.find((u) => u.machine === "RF Body");
  ok("reporting: machine utilization reports RF Body", !!rfRow, JSON.stringify(usage));
  ok("reporting: voided visits are excluded from utilization",
     (rfRow?.machineVisits ?? 0) > 0 &&
       usage.reduce((s, u) => s + u.sessions, 0) > 0);
  const historyAfterVoid = await listMachineVisits({ clientId: voidClient.id });
  ok("reporting: a voided visit stays visible in history",
     historyAfterVoid.length === 1 && historyAfterVoid[0].status === "voided");

  console.log("done");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await db.$disconnect();
});
