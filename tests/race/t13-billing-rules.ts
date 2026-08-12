/**
 * Session-plan & bundle billing rules, end to end. Test DB only (see run.sh).
 * Locks in: a plan bills its FULL sessionsNeeded upfront (never what is used
 * today), one active plan per client per machine (DB-enforced), no phantom
 * balance after a deleted visit, no refunds on a paid visit, and a bundle
 * billing its fixed price rather than sessions x per-session rate.
 */
import { db } from "@/server/db";
import { createConsultation, deleteConsultation } from "@/server/repositories/consultations";
import { createSessionPlan } from "@/server/repositories/sessionPlans";
import { listVisitBaskets, settleVisitBasket, updateVisitBasket } from "@/server/repositories/visitBaskets";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

async function main() {
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.package.deleteMany({});

  const doc = await db.user.create({
    data: { fullName: "Dr B", email: "b@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  const client = await db.client.create({
    data: { firstName: "Bill", lastName: "Ing", phone: "+96170123456" },
  });
  await db.servicePrice.create({
    data: { kind: "treatment", key: "Cryolipolysis", name: "Cryolipolysis", price: 10, currency: "USD", active: true },
  });

  // ---- 1. Session plan: 13 needed, 1 used today, $10/session -> $130
  const plan = await createSessionPlan({ clientId: client.id, machine: "Cryolipolysis", sessionsNeeded: 13 });
  const v1 = await createConsultation({
    clientId: client.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 13, sessionsUsed: 1, sessionPlanId: plan.id }],
  });
  let baskets = await listVisitBaskets({ clientId: client.id, status: "pending" });
  ok("visit 1 basket = $130", baskets[0]?.total === 130, `got ${baskets[0]?.total}`);

  await settleVisitBasket(baskets[0].id, { splits: [{ method: "cash", amount: 130 }], actorName: "Sec" });
  let p = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  ok("13 purchased / 1 used / 12 remaining", p.sessionsPaid === 13 && p.sessionsUsed === 1,
     `paid=${p.sessionsPaid} used=${p.sessionsUsed} credit=${p.sessionsPaid - p.sessionsUsed}`);

  // ---- 2. Next visit: uses prepaid credit, charges nothing
  await db.consultation.update({ where: { id: v1.id }, data: { status: "closed" } });
  await createConsultation({
    clientId: client.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 13, sessionsUsed: 1, sessionPlanId: plan.id }],
  });
  baskets = await listVisitBaskets({ clientId: client.id, status: "pending" });
  ok("visit 2 charges nothing (no basket raised)", baskets.length === 0, `got ${baskets.length} basket(s)`);
  p = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  ok("11 remaining after visit 2", p.sessionsPaid - p.sessionsUsed === 11,
     `paid=${p.sessionsPaid} used=${p.sessionsUsed}`);

  // ---- 3. One active plan per client per machine
  const again = await createSessionPlan({ clientId: client.id, machine: "Cryolipolysis", sessionsNeeded: 5 });
  ok("createSessionPlan reuses the active plan", again.id === plan.id, `got ${again.id}`);
  ok("reuse never lowers below sessionsPaid", again.sessionsNeeded === 13, `needed=${again.sessionsNeeded}`);
  let dbBlocked = false;
  try {
    await db.sessionPlan.create({
      data: { clientId: client.id, machine: "Cryolipolysis", activeMachineKey: "Cryolipolysis",
              unitPrice: 10, currency: "USD", sessionsNeeded: 3, status: "active" },
    });
  } catch { dbBlocked = true; }
  ok("DB rejects a second ACTIVE plan for the same machine", dbBlocked);

  // ---- 4. Deleting an unpaid visit gives back the purchase quantity
  const v3 = await db.consultation.findFirstOrThrow({ where: { clientId: client.id, status: "open" } });
  await db.consultation.update({ where: { id: v3.id }, data: { status: "closed" } });
  const plan2 = await createSessionPlan({ clientId: client.id, machine: "Cryolipolysis", sessionsNeeded: 20 });
  const v4 = await createConsultation({
    clientId: client.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 20, sessionsUsed: 1, sessionPlanId: plan2.id }],
  });
  baskets = await listVisitBaskets({ clientId: client.id, status: "pending" });
  ok("raising needed 13->20 bills the 7 new sessions", baskets[0]?.total === 70, `got ${baskets[0]?.total}`);
  await deleteConsultation(v4.id, { actorName: "Dr B", actorEmail: doc.email, actorRole: "admin" });
  p = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan.id } });
  ok("deleted visit leaves no phantom balance", p.sessionsNeeded === 13 && p.sessionsPaid === 13,
     `needed=${p.sessionsNeeded} paid=${p.sessionsPaid}`);
  ok("credit restored after delete", p.sessionsPaid - p.sessionsUsed === 11, `used=${p.sessionsUsed}`);

  // ---- 5. A paid but still-open visit cannot be deleted (no refunds)
  const client3 = await db.client.create({ data: { firstName: "Paid", lastName: "Open", phone: "+96170123458" } });
  const plan3 = await createSessionPlan({ clientId: client3.id, machine: "Cryolipolysis", sessionsNeeded: 4 });
  const v5 = await createConsultation({
    clientId: client3.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 4, sessionsUsed: 1, sessionPlanId: plan3.id }],
  });
  const b5 = await listVisitBaskets({ clientId: client3.id, status: "pending" });
  ok("plan of 4 bills $40 upfront", b5[0]?.total === 40, `got ${b5[0]?.total}`);
  await settleVisitBasket(b5[0].id, { splits: [{ method: "cash", amount: 40 }], actorName: "Sec" });
  let refused = "";
  try {
    await deleteConsultation(v5.id, { actorName: "Dr B", actorEmail: doc.email, actorRole: "admin" });
  } catch (e) { refused = (e as Error).message; }
  ok("paid visit refuses deletion (no refunds)", refused.includes("never refunded"), refused || "no error thrown");
  const p3 = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan3.id } });
  ok("paid plan keeps its credit", p3.sessionsPaid === 4 && p3.sessionsUsed === 1,
     `paid=${p3.sessionsPaid} used=${p3.sessionsUsed}`);

  // ---- 6. A session-plan line can't be part-paid at checkout (server-side)
  const client4 = await db.client.create({ data: { firstName: "Part", lastName: "Pay", phone: "+96170123459" } });
  const plan4 = await createSessionPlan({ clientId: client4.id, machine: "Cryolipolysis", sessionsNeeded: 12 });
  await createConsultation({
    clientId: client4.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 12, sessionsUsed: 1, sessionPlanId: plan4.id }],
  });
  const [b6] = await listVisitBaskets({ clientId: client4.id, status: "pending" });
  ok("plan of 12 bills $120 upfront", b6.total === 120, `got ${b6.total}`);
  const sentItems = b6.items.map((i) => ({
    kind: i.kind, label: i.label, detail: i.detail, quantity: i.quantity,
    unitPrice: i.unitPrice, currency: i.currency, covered: i.covered,
    sessionPlanId: i.sessionPlanId, productId: i.productId,
  }));
  const actor = { name: "Sec", email: "sec@test.local", role: "secretary" };
  const patch = async (items: typeof sentItems) => {
    try {
      await updateVisitBasket(b6.id, { items, currency: "USD" }, actor);
      return "";
    } catch (e) { return (e as Error).message; }
  };
  ok("reducing a plan line's quantity is refused",
     (await patch(sentItems.map((i) => (i.sessionPlanId ? { ...i, quantity: 3 } : i)))).includes("paid upfront in full"));
  ok("dropping a plan line is refused",
     (await patch(sentItems.filter((i) => !i.sessionPlanId))).includes("paid upfront in full"));
  ok("repricing a plan line is refused",
     (await patch(sentItems.map((i) => (i.sessionPlanId ? { ...i, unitPrice: 1 } : i)))).includes("paid upfront in full"));
  ok("inventing a plan line is refused",
     (await patch([...sentItems, { kind: "treatment", label: "Cryolipolysis", detail: undefined, quantity: 5,
                                   unitPrice: 10, currency: "USD", covered: false,
                                   sessionPlanId: plan4.id, productId: undefined }])).includes("paid upfront in full"));
  ok("a non-plan line added at checkout still goes through",
     (await patch([...sentItems, { kind: "product", label: "Shaker", detail: undefined, quantity: 2,
                                   unitPrice: 5, currency: "USD", covered: false,
                                   sessionPlanId: undefined, productId: undefined }])) === "");
  const after = await db.visitBasket.findUniqueOrThrow({ where: { id: b6.id }, include: { items: true } });
  const planQty = after.items.filter((i) => i.sessionPlanId && !i.covered).reduce((n, i) => n + i.quantity, 0);
  ok("the plan line survived every attempt intact", planQty === 12, `qty=${planQty}`);
  const p4 = await db.sessionPlan.findUniqueOrThrow({ where: { id: plan4.id } });
  ok("nothing was credited to the plan before settlement", p4.sessionsPaid === 0, `paid=${p4.sessionsPaid}`);

  // ---- 7. Bundle: fixed price, bundle quantity credited
  const bundle = await db.package.create({
    data: { name: "Cryo 15", machine: "Cryolipolysis", sessions: 15, price: 140, cost: 0,
            currency: "USD", discountPercent: 0, status: "active" },
  });
  const client2 = await db.client.create({ data: { firstName: "Bun", lastName: "Dle", phone: "+96170123457" } });
  await createConsultation({
    clientId: client2.id, dietitianId: doc.id,
    treatments: [{ machine: "Cryolipolysis", sessionsNeeded: 13, sessionsUsed: 1, applyPackageId: bundle.id }],
  });
  const b2 = await listVisitBaskets({ clientId: client2.id, status: "pending" });
  ok("bundle basket = fixed $140 (not 13x10 or 15x10)", b2[0]?.total === 140, `got ${b2[0]?.total}`);
  const cp = await db.clientPackage.findFirstOrThrow({ where: { clientId: client2.id } });
  ok("15 sessions credited, 1 used, 14 left", cp.totalSessions === 15 && cp.usedSessions === 1,
     `total=${cp.totalSessions} used=${cp.usedSessions}`);

  await db.$disconnect();
}
main();
