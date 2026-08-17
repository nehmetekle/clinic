/**
 * Settle-before-use: the rule that sessions are bought first, the basket is
 * settled (paid now OR moved to a ClientDebt), and only then are the sessions
 * usable. Test DB only (see run.sh).
 *
 * Locks in the invariants the redesign rests on:
 *   - a PAID basket unlocks sessions;
 *   - a basket settled entirely as ClientDebt unlocks them identically;
 *   - a PENDING basket unlocks nothing;
 *   - the same money is never tracked as both a plan balance and a debt;
 *   - settling twice unlocks once;
 *   - forgiving the debt keeps the sessions;
 *   - the standalone front-desk sale works end to end;
 *   - the originating consultation may deliver before checkout;
 *   - `available` never goes negative.
 */
import { db } from "@/server/db";
import { createConsultation } from "@/server/repositories/consultations";
import { createMachineVisit } from "@/server/repositories/machineVisits";
import { createSessionPlan, sellSessions } from "@/server/repositories/sessionPlans";
import { listVisitBaskets, settleVisitBasket } from "@/server/repositories/visitBaskets";
import { listClientDebts, voidClientDebt } from "@/server/repositories/clientDebts";
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

const plan = (id: string) => db.sessionPlan.findUniqueOrThrow({ where: { id } });
const available = (p: { sessionsPaid: number; sessionsUsed: number }) =>
  Math.max(0, p.sessionsPaid - p.sessionsUsed);

async function main() {
  await db.auditLog.deleteMany({});
  await db.machineVisit.deleteMany({});
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.package.deleteMany({});

  const doc = await db.user.create({
    data: { fullName: "Dr S", email: "s@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  const actor: MachineVisitActor = { id: doc.id, name: doc.fullName, role: "dietitian" };
  await db.servicePrice.create({
    data: { kind: "treatment", key: "RF Body", name: "RF Body", price: 10, currency: "USD", active: true },
  });

  const mkClient = (n: string, phone: string) =>
    db.client.create({ data: { firstName: n, lastName: "Case", phone } });

  // =====================================================================
  // 1. Standalone sale, settled by PAYMENT -> sessions unlock
  // =====================================================================
  const c1 = await mkClient("Pay", "+96170000001");
  const sale1 = await sellSessions({ clientId: c1.id, machine: "RF Body", sessions: 4 }, { id: doc.id, name: "Sec" });
  ok("sale: plan created with the prescribed course", sale1.plan.sessionsNeeded === 4,
     `needed=${sale1.plan.sessionsNeeded}`);
  ok("sale: nothing unlocked yet", sale1.plan.sessionsPaid === 0, `paid=${sale1.plan.sessionsPaid}`);

  const [b1] = await listVisitBaskets({ clientId: c1.id, status: "pending" });
  ok("sale: basket = 4 x $10", b1?.total === 40, `total=${b1?.total}`);
  ok("sale: basket is not tied to a consultation", !b1?.consultationId);
  // A sale belongs to no visit and no doctor. It must stay reachable by client so
  // the profile's Payments tab can settle it on ANY later day — the queue board's
  // Payment lane only carries today's baskets, so it can't be the only way in.
  ok("sale: basket carries no dietitian", !b1?.dietitianId, `dietitianId=${b1?.dietitianId}`);
  await db.visitBasket.update({
    where: { id: b1.id },
    data: { sentAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
  });
  ok("sale: a days-old unsettled basket is still listed for its client",
     (await listVisitBaskets({ clientId: c1.id, status: "pending" })).some((b) => b.id === b1.id));

  // A PENDING basket unlocks nothing.
  await expectFailure(
    "pending basket unlocks nothing",
    () => createMachineVisit({ clientId: c1.id, items: [{ sessionPlanId: sale1.plan.id, sessions: 1 }] }, actor),
    /0 sessions available/i,
  );

  await settleVisitBasket(b1.id, { splits: [{ method: "cash", amount: 40 }], actorName: "Sec" });
  let p1 = await plan(sale1.plan.id);
  ok("paid basket unlocks 4 sessions", p1.sessionsPaid === 4 && available(p1) === 4,
     `paid=${p1.sessionsPaid} available=${available(p1)}`);
  ok("paid basket raised no debt", (await listClientDebts(c1.id)).length === 0);

  await createMachineVisit({ clientId: c1.id, items: [{ sessionPlanId: sale1.plan.id, sessions: 2 }] }, actor);
  p1 = await plan(sale1.plan.id);
  ok("machine visit consumes settled sessions", available(p1) === 2, `available=${available(p1)}`);
  ok("machine visit created no basket",
     (await listVisitBaskets({ clientId: c1.id, status: "pending" })).length === 0);
  ok("machine visit created no extra payment",
     (await db.payment.count({ where: { clientId: c1.id } })) === 1);

  // =====================================================================
  // 2. Same sale settled entirely as ClientDebt -> unlocks identically
  // =====================================================================
  const c2 = await mkClient("Debt", "+96170000002");
  const sale2 = await sellSessions({ clientId: c2.id, machine: "RF Body", sessions: 4 }, { id: doc.id, name: "Sec" });
  const [b2] = await listVisitBaskets({ clientId: c2.id, status: "pending" });
  ok("debt route: basket = $40", b2?.total === 40, `total=${b2?.total}`);

  await settleVisitBasket(b2.id, {
    splits: [],
    debtAmount: 40,
    debtReason: "no money",
    actorName: "Sec",
  });
  const p2 = await plan(sale2.plan.id);
  ok("debt settlement unlocks 4 sessions", p2.sessionsPaid === 4 && available(p2) === 4,
     `paid=${p2.sessionsPaid} available=${available(p2)}`);
  ok("debt settlement flipped the basket to paid",
     (await db.visitBasket.findUniqueOrThrow({ where: { id: b2.id } })).status === "paid");
  ok("debt settlement collected no money",
     (await db.payment.count({ where: { clientId: c2.id } })) === 0);

  const debts2 = await listClientDebts(c2.id);
  ok("debt of exactly $40 recorded once", debts2.length === 1 && debts2[0].amount === 40,
     `debts=${debts2.length} amount=${debts2[0]?.amount}`);

  // The money is tracked in ONE place: the debt. The plan carries no balance owed.
  ok("no double tracking: plan shows nothing left to buy",
     p2.sessionsNeeded - p2.sessionsPaid === 0,
     `needed=${p2.sessionsNeeded} paid=${p2.sessionsPaid}`);

  await createMachineVisit({ clientId: c2.id, items: [{ sessionPlanId: sale2.plan.id, sessions: 4 }] }, actor);
  const p2Used = await plan(sale2.plan.id);
  ok("debt-settled sessions are fully usable", p2Used.sessionsUsed === 4, `used=${p2Used.sessionsUsed}`);
  ok("consuming them billed nothing",
     (await listVisitBaskets({ clientId: c2.id, status: "pending" })).length === 0);

  // =====================================================================
  // 3. Forgiving the debt keeps the sessions
  // =====================================================================
  const c3 = await mkClient("Forgiven", "+96170000003");
  const sale3 = await sellSessions({ clientId: c3.id, machine: "RF Body", sessions: 3 }, { id: doc.id, name: "Sec" });
  const [b3] = await listVisitBaskets({ clientId: c3.id, status: "pending" });
  await settleVisitBasket(b3.id, { splits: [], debtAmount: 30, debtReason: "later", actorName: "Sec" });
  const [d3] = await listClientDebts(c3.id);
  await voidClientDebt(d3.id, { reason: "goodwill", clearedByName: "Admin" });
  const p3 = await plan(sale3.plan.id);
  ok("forgiveness keeps the sessions", p3.sessionsPaid === 3 && available(p3) === 3,
     `paid=${p3.sessionsPaid} available=${available(p3)}`);
  ok("forgiveness did not unlock again", p3.sessionsPaid === 3, `paid=${p3.sessionsPaid}`);
  await createMachineVisit({ clientId: c3.id, items: [{ sessionPlanId: sale3.plan.id, sessions: 3 }] }, actor);
  ok("forgiven sessions still consumable", (await plan(sale3.plan.id)).sessionsUsed === 3);

  // =====================================================================
  // 4. Settling twice unlocks once
  // =====================================================================
  const c4 = await mkClient("Twice", "+96170000004");
  const sale4 = await sellSessions({ clientId: c4.id, machine: "RF Body", sessions: 5 }, { id: doc.id, name: "Sec" });
  const [b4] = await listVisitBaskets({ clientId: c4.id, status: "pending" });
  await settleVisitBasket(b4.id, { splits: [{ method: "cash", amount: 50 }], actorName: "Sec" });
  await expectFailure(
    "settling an already-settled basket is refused",
    () => settleVisitBasket(b4.id, { splits: [{ method: "cash", amount: 50 }], actorName: "Sec" }),
    /already settled/i,
  );
  const p4 = await plan(sale4.plan.id);
  ok("a second settle unlocked nothing extra", p4.sessionsPaid === 5, `paid=${p4.sessionsPaid}`);
  ok("a second settle collected nothing extra",
     (await db.payment.count({ where: { clientId: c4.id } })) === 1);

  // Two settles racing the same basket: one wins, one payment, one unlock.
  const c5 = await mkClient("Race", "+96170000005");
  const sale5 = await sellSessions({ clientId: c5.id, machine: "RF Body", sessions: 6 }, { id: doc.id, name: "Sec" });
  const [b5] = await listVisitBaskets({ clientId: c5.id, status: "pending" });
  const raced = await Promise.allSettled([
    settleVisitBasket(b5.id, { splits: [{ method: "cash", amount: 60 }], actorName: "A" }),
    settleVisitBasket(b5.id, { splits: [{ method: "cash", amount: 60 }], actorName: "B" }),
  ]);
  ok("race: exactly one settle succeeds",
     raced.filter((r) => r.status === "fulfilled").length === 1,
     `${raced.filter((r) => r.status === "fulfilled").length} succeeded`);
  const p5 = await plan(sale5.plan.id);
  ok("race: unlocked exactly 6, never 12", p5.sessionsPaid === 6, `paid=${p5.sessionsPaid}`);
  ok("race: exactly one payment", (await db.payment.count({ where: { clientId: c5.id } })) === 1);

  // =====================================================================
  // 5. Originating consultation: prescribe, deliver, settle afterwards
  // =====================================================================
  const c6 = await mkClient("Origin", "+96170000006");
  const plan6 = await createSessionPlan({ clientId: c6.id, machine: "RF Body", sessionsNeeded: 4 });
  const v6 = await createConsultation({
    clientId: c6.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "RF Body", sessionsNeeded: 4, sessionsUsed: 1, sessionPlanId: plan6.id }],
  });
  let p6 = await plan(plan6.id);
  ok("originating visit may deliver before checkout", p6.sessionsUsed === 1, `used=${p6.sessionsUsed}`);
  ok("nothing is unlocked before checkout", p6.sessionsPaid === 0, `paid=${p6.sessionsPaid}`);
  ok("available is clamped at zero, never negative", available(p6) === 0, `available=${available(p6)}`);

  // A LATER machine visit cannot ride on that unsettled purchase.
  await expectFailure(
    "later machine visit cannot use unsettled sessions",
    () => createMachineVisit({ clientId: c6.id, items: [{ sessionPlanId: plan6.id, sessions: 1 }] }, actor),
    /0 sessions available/i,
  );

  const [b6] = await listVisitBaskets({ clientId: c6.id, status: "pending" });
  ok("originating visit billed the whole course once", b6?.total === 40, `total=${b6?.total}`);
  await settleVisitBasket(b6.id, { splits: [], debtAmount: 40, debtReason: "next visit", actorName: "Sec" });
  p6 = await plan(plan6.id);
  ok("checkout unlocks the course", p6.sessionsPaid === 4, `paid=${p6.sessionsPaid}`);
  ok("the delivered session is accounted for", available(p6) === 3, `available=${available(p6)}`);
  await createMachineVisit({ clientId: c6.id, items: [{ sessionPlanId: plan6.id, sessions: 3 }] }, actor);
  ok("the rest of the course is consumable", (await plan(plan6.id)).sessionsUsed === 4);
  ok("no double billing across the whole life of the plan",
     (await db.visitBasket.count({ where: { clientId: c6.id } })) === 1);
  void v6;

  // =====================================================================
  // 6. No double billing: a top-up sale is not re-billed by the next visit
  // =====================================================================
  const c7 = await mkClient("TopUp", "+96170000007");
  const plan7 = await createSessionPlan({ clientId: c7.id, machine: "RF Body", sessionsNeeded: 2 });
  const v7 = await createConsultation({
    clientId: c7.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "RF Body", sessionsNeeded: 2, sessionsUsed: 0, sessionPlanId: plan7.id }],
  });
  const [b7] = await listVisitBaskets({ clientId: c7.id, status: "pending" });
  await settleVisitBasket(b7.id, { splits: [{ method: "cash", amount: 20 }], actorName: "Sec" });
  await db.consultation.update({ where: { id: v7.id }, data: { status: "closed" } });

  // Front desk tops up 3 more; the sale is still pending.
  const sale7 = await sellSessions({ clientId: c7.id, machine: "RF Body", sessions: 3 }, { id: doc.id, name: "Sec" });
  ok("top-up raises the prescribed course to 5", sale7.plan.sessionsNeeded === 5,
     `needed=${sale7.plan.sessionsNeeded}`);
  const saleBasket = await db.visitBasket.findUniqueOrThrow({
    where: { id: sale7.basketId },
    include: { items: true },
  });
  ok("top-up basket = 3 x $10",
     saleBasket.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) === 30);

  // A new consultation on the same plan must NOT re-sell those 3 pending sessions.
  await createConsultation({
    clientId: c7.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "RF Body", sessionsNeeded: 5, sessionsUsed: 0, sessionPlanId: plan7.id }],
  });
  const stillPending = await listVisitBaskets({ clientId: c7.id, status: "pending" });
  const consultBasket = stillPending.find((b) => b.consultationId);
  ok("no double billing: the next visit sells nothing already on a basket",
     consultBasket === undefined,
     `consultation basket total=${consultBasket?.total}`);
  ok("no double billing: only the top-up sale is still owed",
     stillPending.length === 1 && stillPending[0].total === 30,
     `${stillPending.length} pending, total=${stillPending[0]?.total}`);

  await settleVisitBasket(sale7.basketId, { splits: [{ method: "cash", amount: 30 }], actorName: "Sec" });
  const p7 = await plan(plan7.id);
  ok("both purchases unlocked exactly once", p7.sessionsPaid === 5, `paid=${p7.sessionsPaid}`);
  ok("total collected = $50, never $80",
     (await db.payment.aggregate({ where: { clientId: c7.id }, _sum: { amountPaid: true } }))._sum.amountPaid === 50);

  // =====================================================================
  // 7. Database constraints
  // =====================================================================
  await expectFailure(
    "db: sessionsPaid cannot exceed the prescribed course",
    () =>
      db.$executeRawUnsafe(
        `UPDATE "SessionPlan" SET "sessionsPaid" = "sessionsNeeded" + 1 WHERE "id" = '${plan7.id}'`,
      ),
    /SessionPlan_bought_within_prescribed/,
  );
  await expectFailure(
    "db: sessionsUsed cannot exceed the prescribed course",
    () =>
      db.$executeRawUnsafe(
        `UPDATE "SessionPlan" SET "sessionsUsed" = "sessionsNeeded" + 1 WHERE "id" = '${plan7.id}'`,
      ),
    /SessionPlan_bought_within_prescribed/,
  );

  // =====================================================================
  // 8. Bundles keep the same prepaid principle (no billing on use)
  // =====================================================================
  const bundle = await db.package.create({
    data: { name: "RF 10", machine: "RF Body", sessions: 10, price: 90, cost: 0,
            currency: "USD", discountPercent: 0, status: "active" },
  });
  const c8 = await mkClient("Bundle", "+96170000008");
  await createConsultation({
    clientId: c8.id,
    dietitianId: doc.id,
    waiveConsultationFee: true,
    treatments: [{ machine: "RF Body", sessionsNeeded: 10, sessionsUsed: 1, applyPackageId: bundle.id }],
  });
  const [b8] = await listVisitBaskets({ clientId: c8.id, status: "pending" });
  ok("bundle still bills its fixed price once", b8?.total === 90, `total=${b8?.total}`);
  await settleVisitBasket(b8.id, { splits: [{ method: "cash", amount: 90 }], actorName: "Sec" });
  const cp8 = await db.clientPackage.findFirstOrThrow({ where: { clientId: c8.id } });
  await createMachineVisit({ clientId: c8.id, items: [{ clientPackageId: cp8.id, sessions: 4 }] }, actor);
  ok("bundle consumption bills nothing",
     (await listVisitBaskets({ clientId: c8.id, status: "pending" })).length === 0);
  await expectFailure(
    "bundle over-consumption is refused, not clamped",
    () => createMachineVisit({ clientId: c8.id, items: [{ clientPackageId: cp8.id, sessions: 99 }] }, actor),
    /left on this bundle/i,
  );
  ok("bundle counters intact after the refusal",
     (await db.clientPackage.findUniqueOrThrow({ where: { id: cp8.id } })).usedSessions === 5);

  await db.$disconnect();
}
main();
