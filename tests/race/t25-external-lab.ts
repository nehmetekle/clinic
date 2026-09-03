/**
 * External Lab Blood Collection: billing, the three-state payload, below-cost
 * governance, the cost-visibility split, the settled freeze, checkout price
 * protection, concurrency and reporting. Test DB only (see run.sh).
 *
 * The rules this locks in, in the order a reviewer would want to check them:
 *
 *  - the order bills as ONE line at its negotiated sale total, costed at what
 *    the lab charges — never per test, because the lab quotes the group;
 *  - a save that OMITS the section leaves the order alone AND keeps billing it
 *    (an absent key must never quietly reduce what the patient owes), while an
 *    explicit `null` removes it;
 *  - selling below cost is allowed but never anonymous, and the justification is
 *    cleared once it no longer applies;
 *  - a caller who may not set the cost cannot blank it to 0 and turn the order
 *    into pure profit;
 *  - the secretary never RECEIVES the cost — it is absent from the payload, not
 *    hidden in the UI — but may still correct the sale price;
 *  - a SETTLED order is frozen for everyone, and stays frozen once the visit
 *    closes and its basket flips `paid` -> `closed` (the regression that made
 *    this file worth writing);
 *  - the price can't be retyped at checkout, only re-derived from the order;
 *  - concurrent saves/repricings can't double-bill or leave the bill disagreeing
 *    with the order it came from;
 *  - the per-order report sums exactly to the `external_lab` row of the revenue
 *    breakdown.
 */
import { db } from "@/server/db";
import {
  closeConsultation,
  createConsultation,
  updateConsultation,
} from "@/server/repositories/consultations";
import {
  getExternalLabOrder,
  setExternalLabSalePrice,
} from "@/server/repositories/externalLabOrders";
import {
  listVisitBaskets,
  settleVisitBasket,
  updateVisitBasket,
} from "@/server/repositories/visitBaskets";
import {
  getExternalLabProfitability,
  getProfitability,
} from "@/server/repositories/profitability";
import { createSession, SESSION_COOKIE_NAME } from "@/server/session";
import {
  GET as ORDER_GET,
  PATCH as ORDER_PATCH,
} from "@/app/api/consultations/[id]/external-lab-order/route";

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
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
}

/** The clinical actor's permissions, as the routes resolve them for a doctor. */
const DOCTOR_PERMS = { actorCanOrderExternalLab: true, actorCanSetExternalLabCost: true };

const labOrder = (tests: { name: string; description?: string }[], cost: number, sale: number, extra: object = {}) => ({
  totalCostPrice: cost,
  totalSalePrice: sale,
  tests,
  ...extra,
});

/** The single external-lab line on a client's only pending basket. */
async function pendingLabLine(clientId: string) {
  const baskets = await listVisitBaskets({ clientId, status: "pending" });
  const items = baskets.flatMap((b) => b.items.filter((i) => i.kind === "external_lab"));
  return { basket: baskets[0], line: items[0], lineCount: items.length };
}

async function main() {
  await reset();

  const doc = await db.user.create({
    data: { fullName: "Dr L", email: "l@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  const secretary = await db.user.create({
    data: { fullName: "Front Desk", email: "sec@test.local", role: "secretary", passwordHash: "x" },
  });
  const admin = await db.user.create({
    data: { fullName: "Owner", email: "admin@test.local", role: "admin", passwordHash: "x" },
  });

  const john = await db.client.create({
    data: { firstName: "John", lastName: "Lab", phone: "+96170123401" },
  });

  // =====================================================================
  // 1. The order bills as ONE line at the sale total
  // =====================================================================
  const v1 = await createConsultation(
    {
      clientId: john.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      externalLabOrder: labOrder(
        [{ name: "Cholesterol", description: "fasting" }, { name: "Vitamin D" }],
        300,
        1000,
      ),
    },
    DOCTOR_PERMS,
  );

  {
    const { line, lineCount } = await pendingLabLine(john.id);
    ok("bills exactly one line for the whole order", lineCount === 1, `lines=${lineCount}`);
    ok("line is priced at the SALE total, not per test", line?.unitPrice === 1000, `unitPrice=${line?.unitPrice}`);
    ok("line quantity is 1 (the order is the unit)", line?.quantity === 1, `qty=${line?.quantity}`);
    ok("line kind is external_lab", line?.kind === "external_lab", `kind=${line?.kind}`);
    ok("line carries the order id (price protection)", Boolean(line?.externalLabOrderId));
    // The cost is frozen on the row but must never be serialized to a client.
    const row = await db.visitBasketItem.findFirstOrThrow({ where: { kind: "external_lab" } });
    ok("cost is frozen onto the line as unitCost", row.unitCost === 300, `unitCost=${row.unitCost}`);
    ok("cost is NOT serialized onto the basket item",
       !("unitCost" in (line as object)), `keys=${Object.keys(line ?? {}).join(",")}`);
  }

  // Test lines carry no price of any kind — the schema has nowhere to put one.
  {
    const tests = await db.consultationExternalLabTest.findMany({
      where: { order: { consultationId: v1.id } },
      orderBy: { position: "asc" },
    });
    ok("test lines are stored in the order they were listed",
       tests.map((t) => t.name).join(",") === "Cholesterol,Vitamin D", tests.map((t) => t.name).join(","));
    ok("a test line has no price column at all",
       !Object.keys(tests[0] ?? {}).some((k) => /price|cost|amount/i.test(k)),
       Object.keys(tests[0] ?? {}).join(","));
  }

  // =====================================================================
  // 2. Three-state payload: omitted keeps billing, null removes
  // =====================================================================
  {
    // An unrelated save that never opened the card. The order must survive AND
    // stay on the bill — the basket is rebuilt from scratch on every save, so a
    // dropped contribution would silently reduce what the patient owes.
    await updateConsultation(
      v1.id,
      { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true, notes: "unrelated edit" },
      DOCTOR_PERMS,
    );
    const { line, lineCount } = await pendingLabLine(john.id);
    ok("omitted section: order survives", (await db.consultationExternalLabOrder.count()) === 1);
    ok("omitted section: charge is still on the basket", lineCount === 1 && line?.unitPrice === 1000,
       `lines=${lineCount} unitPrice=${line?.unitPrice}`);

    // Explicit null is a real instruction, and must not be confused with absent.
    await updateConsultation(
      v1.id,
      { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true, externalLabOrder: null },
      DOCTOR_PERMS,
    );
    ok("null: order removed", (await db.consultationExternalLabOrder.count()) === 0);
    ok("null: charge gone from the basket", (await pendingLabLine(john.id)).lineCount === 0);

    // Put it back for the rest of the file.
    await updateConsultation(
      v1.id,
      {
        clientId: john.id,
        dietitianId: doc.id,
        waiveConsultationFee: true,
        externalLabOrder: labOrder([{ name: "Cholesterol" }, { name: "Vitamin D" }], 300, 1000),
      },
      DOCTOR_PERMS,
    );
    ok("re-added after removal", (await db.consultationExternalLabOrder.count()) === 1);
  }

  // =====================================================================
  // 3. Below cost: allowed, but never anonymous
  // =====================================================================
  {
    const below = { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true,
                    externalLabOrder: labOrder([{ name: "Vitamin D" }], 300, 100) };
    await expectFailure(
      "below cost without a reason is refused",
      () => updateConsultation(v1.id, below, DOCTOR_PERMS),
      /below what the lab charges us/i,
    );

    await updateConsultation(
      v1.id,
      { ...below, externalLabOrder: labOrder([{ name: "Vitamin D" }], 300, 100, { belowCostReason: "goodwill" }) },
      DOCTOR_PERMS,
    );
    let order = await db.consultationExternalLabOrder.findFirstOrThrow();
    ok("below cost with a reason is accepted", order.totalSalePrice === 100 && order.belowCostReason === "goodwill",
       `sale=${order.totalSalePrice} reason=${order.belowCostReason}`);
    ok("below-cost sale gets its own audit line",
       (await db.auditLog.count({ where: { action: "External lab order priced below cost" } })) > 0);

    // Back above cost: the justification no longer applies and must not linger.
    await updateConsultation(
      v1.id,
      { ...below, externalLabOrder: labOrder([{ name: "Cholesterol" }, { name: "Vitamin D" }], 300, 1000, { belowCostReason: "goodwill" }) },
      DOCTOR_PERMS,
    );
    order = await db.consultationExternalLabOrder.findFirstOrThrow();
    ok("reason is cleared once the price is back at/above cost", order.belowCostReason === null,
       `reason=${order.belowCostReason}`);
  }

  // =====================================================================
  // 4. Amount validation, and the CHECK constraints behind it
  // =====================================================================
  {
    const base = { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true };
    await expectFailure(
      "a negative sale price is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: labOrder([{ name: "X" }], 10, -1) }, DOCTOR_PERMS),
    );
    await expectFailure(
      "an absurd total is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: labOrder([{ name: "X" }], 0, 9_999_999) }, DOCTOR_PERMS),
      /maximum allowed amount/i,
    );
    await expectFailure(
      "an order with no named test is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: labOrder([{ name: "   " }], 10, 20) }, DOCTOR_PERMS),
      /at least one test/i,
    );

    // The database is the last line of defence, independent of the application.
    const orderId = (await db.consultationExternalLabOrder.findFirstOrThrow()).id;
    await expectFailure(
      "DB CHECK refuses a below-cost row with no reason, bypassing the app",
      () => db.$executeRawUnsafe(
        `UPDATE "ConsultationExternalLabOrder" SET "totalCostPrice"=500, "totalSalePrice"=1, "belowCostReason"=NULL WHERE id='${orderId}'`,
      ),
      /external_lab_below_cost_needs_reason|violates check constraint/i,
    );
    await expectFailure(
      "DB CHECK refuses a negative total, bypassing the app",
      () => db.$executeRawUnsafe(
        `UPDATE "ConsultationExternalLabOrder" SET "totalCostPrice"=-5 WHERE id='${orderId}'`,
      ),
      /external_lab_order_totals_nonnegative|violates check constraint/i,
    );
  }

  // =====================================================================
  // 5. A caller who may not set the cost cannot blank it
  // =====================================================================
  {
    // The route gate is stricter than this today, but the rule belongs with the
    // write: without it, a cost-blind save turns a $300-cost order into one that
    // reports as pure profit.
    await updateConsultation(
      v1.id,
      {
        clientId: john.id,
        dietitianId: doc.id,
        waiveConsultationFee: true,
        externalLabOrder: { totalSalePrice: 1000, tests: [{ name: "Cholesterol" }, { name: "Vitamin D" }] },
      },
      { actorCanOrderExternalLab: true, actorCanSetExternalLabCost: false },
    );
    const order = await db.consultationExternalLabOrder.findFirstOrThrow();
    ok("cost-blind save preserves the stored cost", order.totalCostPrice === 300, `cost=${order.totalCostPrice}`);
  }

  // An actor with no ordering right can't touch the section at all.
  await expectFailure(
    "an unauthorized actor cannot change the order",
    () => updateConsultation(
      v1.id,
      { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true,
        externalLabOrder: labOrder([{ name: "Cholesterol" }], 1, 1) },
      { actorCanOrderExternalLab: false, actorCanSetExternalLabCost: false },
    ),
    /not authorized/i,
  );

  // =====================================================================
  // 6. Cost visibility: omitted from the payload, not hidden in the UI
  // =====================================================================
  {
    const secretaryToken = await createSession(secretary.id);
    const doctorToken = await createSession(doc.id);
    const adminToken = await createSession(admin.id);
    const request = (token: string | null, method: string, body?: unknown) =>
      new Request(`http://localhost/api/consultations/${v1.id}/external-lab-order`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const params = { params: Promise.resolve({ id: v1.id }) };

    const anon = await ORDER_GET(request(null, "GET"), params);
    ok("route: no session is rejected", anon.status === 403, `status=${anon.status}`);

    const secGet = await ORDER_GET(request(secretaryToken, "GET"), params);
    const secBody = (await secGet.json()) as Record<string, unknown>;
    ok("route: secretary may read the order", secGet.status === 200, `status=${secGet.status}`);
    ok("route: secretary payload OMITS the cost key entirely",
       !("totalCostPrice" in secBody), `keys=${Object.keys(secBody).join(",")}`);
    ok("route: secretary payload omits the below-cost reason too",
       !("belowCostReason" in secBody), `keys=${Object.keys(secBody).join(",")}`);
    ok("route: secretary payload says the cost is withheld", secBody.canSeeCost === false);
    ok("route: secretary still sees what the patient pays", secBody.totalSalePrice === 1000);
    // The whole serialized body must not contain the cost anywhere — not in a
    // nested test line, not in a stray field.
    ok("route: the number 300 appears nowhere in the secretary's response",
       !JSON.stringify(secBody).includes("300"), JSON.stringify(secBody).slice(0, 120));

    for (const [label, token] of [["doctor", doctorToken], ["admin", adminToken]] as const) {
      const res = await ORDER_GET(request(token, "GET"), params);
      const body = (await res.json()) as Record<string, unknown>;
      ok(`route: ${label} receives the cost`, body.totalCostPrice === 300 && body.canSeeCost === true,
         `cost=${body.totalCostPrice} canSeeCost=${body.canSeeCost}`);
    }

    // The front desk's one legitimate edit.
    const repriced = await ORDER_PATCH(request(secretaryToken, "PATCH", { totalSalePrice: 1200 }), params);
    ok("route: secretary may reprice the sale", repriced.status === 200, `status=${repriced.status}`);
    const after = await db.consultationExternalLabOrder.findFirstOrThrow();
    ok("reprice updates the ORDER", after.totalSalePrice === 1200, `sale=${after.totalSalePrice}`);
    const { line } = await pendingLabLine(john.id);
    ok("reprice re-derives the basket line", line?.unitPrice === 1200, `unitPrice=${line?.unitPrice}`);
    ok("reprice leaves the cost untouched", after.totalCostPrice === 300, `cost=${after.totalCostPrice}`);
    ok("reprice is attributed", after.pricedByName === "Front Desk", `by=${after.pricedByName}`);
    // `auditMoney` formats with thousands separators ("USD 1,200"), so assert on
    // the entry itself rather than on a bare digit string.
    const repriceAudit = await db.auditLog.findFirstOrThrow({
      where: { action: "External lab sale price changed" },
      orderBy: { createdAt: "desc" },
    });
    ok("reprice writes an audit line carrying BOTH the old and new price",
       repriceAudit.entityLabel.includes("1,000") && repriceAudit.entityLabel.includes("1,200"),
       repriceAudit.entityLabel);
    ok("reprice audit names the actor and their role",
       repriceAudit.userName === "Front Desk" && /secretary/.test(repriceAudit.entityLabel),
       `${repriceAudit.userName} | ${repriceAudit.entityLabel}`);

    // A below-cost reprice from the desk still needs a justification, and the
    // refusal must not name the cost the secretary may not see.
    const tooLow = await ORDER_PATCH(request(secretaryToken, "PATCH", { totalSalePrice: 50 }), params);
    const tooLowBody = (await tooLow.json()) as { error?: string };
    ok("route: below-cost reprice without a reason is refused", tooLow.status >= 400, `status=${tooLow.status}`);
    ok("route: the refusal does not leak the cost figure",
       !String(tooLowBody.error ?? "").includes("300"), tooLowBody.error ?? "");

    const withReason = await ORDER_PATCH(
      request(secretaryToken, "PATCH", { totalSalePrice: 50, belowCostReason: "manager approved" }),
      params,
    );
    ok("route: below-cost reprice with a reason is accepted", withReason.status === 200, `status=${withReason.status}`);

    // The cost is unreachable from this route however the request is crafted:
    // the schema simply has no field for it.
    await ORDER_PATCH(
      request(secretaryToken, "PATCH", {
        totalSalePrice: 1000,
        totalCostPrice: 1,
        notes: "hacked",
        tests: [{ name: "Injected" }],
      }),
      params,
    );
    const untouched = await db.consultationExternalLabOrder.findFirstOrThrow({ include: { tests: true } });
    ok("route: a smuggled cost in the PATCH body is ignored", untouched.totalCostPrice === 300,
       `cost=${untouched.totalCostPrice}`);
    ok("route: a smuggled test list in the PATCH body is ignored", untouched.tests.length === 2,
       `tests=${untouched.tests.length}`);
    ok("route: a smuggled notes field in the PATCH body is ignored", untouched.notes !== "hacked");
  }

  // =====================================================================
  // 7. Checkout price protection — the desk edits the source, not the line
  // =====================================================================
  {
    const { basket } = await pendingLabLine(john.id);
    const items = basket.items.map((i) => ({
      kind: i.kind, label: i.label, detail: i.detail, quantity: i.quantity,
      unitPrice: i.unitPrice, currency: i.currency, covered: i.covered,
      sessionPlanId: i.sessionPlanId, productId: i.productId,
      clientPackageId: i.clientPackageId, consultationBotoxItemId: i.consultationBotoxItemId,
      externalLabOrderId: i.externalLabOrderId,
    }));

    await expectFailure(
      "checkout: retyping the external-lab line's price is refused",
      () => updateVisitBasket(
        basket.id,
        { items: items.map((i) => (i.kind === "external_lab" ? { ...i, unitPrice: 1 } : i)) },
        { role: "secretary", name: "Front Desk" },
      ),
      /price|can't be changed|not editable/i,
    );

    // A discount is not a price edit, and must remain fully available.
    const discounted = await updateVisitBasket(
      basket.id,
      { items, discountType: "percent", discountValue: 10, discountReason: "loyalty" },
      { role: "secretary", name: "Front Desk" },
    );
    const labLine = discounted.items.find((i) => i.kind === "external_lab");
    ok("checkout: a discount is still allowed and leaves the price standing",
       labLine?.unitPrice === 1000, `unitPrice=${labLine?.unitPrice}`);
  }

  // =====================================================================
  // 8. Settled = frozen. Including after the visit closes.
  // =====================================================================
  {
    const { basket } = await pendingLabLine(john.id);
    await settleVisitBasket(basket.id, {
      splits: [{ method: "cash", amount: basket.total }],
      actorName: "Front Desk",
    });

    const orderId = (await db.consultationExternalLabOrder.findFirstOrThrow()).id;
    const settledView = await getExternalLabOrder(v1.id, { canSeeCost: true });
    ok("settled: the order reports itself as settled", settledView?.settled === true);

    const base = { clientId: john.id, dietitianId: doc.id, waiveConsultationFee: true };
    await expectFailure(
      "settled: repricing through the consultation is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: labOrder([{ name: "Cholesterol" }, { name: "Vitamin D" }], 300, 5000) }, DOCTOR_PERMS),
      /already been settled/i,
    );
    await expectFailure(
      "settled: changing the test list is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: labOrder([{ name: "Something Else" }], 300, 1000) }, DOCTOR_PERMS),
      /already been settled/i,
    );
    await expectFailure(
      "settled: removing the order is refused",
      () => updateConsultation(v1.id, { ...base, externalLabOrder: null }, DOCTOR_PERMS),
      /already been settled/i,
    );
    await expectFailure(
      "settled: the reprice route is refused",
      () => setExternalLabSalePrice(v1.id, { totalSalePrice: 5 }, { name: "Front Desk", role: "secretary" }, { canSeeCost: false }),
      /already been settled/i,
    );

    // An unchanged resend is fine — the editor sends the section on every save.
    await updateConsultation(
      v1.id,
      { ...base, externalLabOrder: labOrder([{ name: "Cholesterol" }, { name: "Vitamin D" }], 300, 1000) },
      DOCTOR_PERMS,
    );
    ok("settled: an unchanged resend is accepted", true);
    ok("settled: no second charge is raised by the resend",
       (await pendingLabLine(john.id)).lineCount === 0);

    // THE REGRESSION. Closing the visit flips its paid basket to `closed`.
    // Testing `paid` alone would un-freeze the order at exactly the moment it is
    // most final — and the reprice route has no closed-visit backstop of its own.
    await closeConsultation(v1.id, { actorName: "Dr L", actorEmail: doc.email, actorRole: "dietitian" });
    const basketAfterClose = await db.visitBasket.findFirstOrThrow({ where: { consultationId: v1.id } });
    ok("close: the settled basket is retired to `closed`", basketAfterClose.status === "closed",
       `status=${basketAfterClose.status}`);
    await expectFailure(
      "closed: the order is STILL frozen against the reprice route",
      () => setExternalLabSalePrice(v1.id, { totalSalePrice: 5 }, { name: "Front Desk", role: "secretary" }, { canSeeCost: false }),
      /already been settled/i,
    );
    const frozen = await db.consultationExternalLabOrder.findUniqueOrThrow({ where: { id: orderId } });
    ok("closed: the sale price never moved", frozen.totalSalePrice === 1000, `sale=${frozen.totalSalePrice}`);
  }

  // =====================================================================
  // 9. Concurrency
  // =====================================================================
  {
    // -- two tabs saving the same draft at once must not double-bill.
    const karl = await db.client.create({
      data: { firstName: "Karl", lastName: "Race", phone: "+96170123402" },
    });
    const v2 = await createConsultation(
      { clientId: karl.id, dietitianId: doc.id, waiveConsultationFee: true },
      DOCTOR_PERMS,
    );
    const payload = {
      clientId: karl.id,
      dietitianId: doc.id,
      waiveConsultationFee: true,
      externalLabOrder: labOrder([{ name: "Vitamin D" }], 100, 400),
    };
    const saves = await Promise.allSettled([
      updateConsultation(v2.id, payload, DOCTOR_PERMS),
      updateConsultation(v2.id, payload, DOCTOR_PERMS),
    ]);
    const landed = saves.filter((r) => r.status === "fulfilled").length;
    ok("race: concurrent saves leave exactly ONE order",
       (await db.consultationExternalLabOrder.count({ where: { consultationId: v2.id } })) === 1,
       `${landed} save(s) landed`);
    const karlLines = await pendingLabLine(karl.id);
    ok("race: concurrent saves leave exactly ONE charge", karlLines.lineCount === 1,
       `lines=${karlLines.lineCount}`);
    ok("race: the charge is the sale price, not a multiple of it", karlLines.line?.unitPrice === 400,
       `unitPrice=${karlLines.line?.unitPrice}`);
    ok("race: the test list wasn't duplicated",
       (await db.consultationExternalLabTest.count({ where: { order: { consultationId: v2.id } } })) === 1);

    // -- two desks repricing at once: whoever lands last wins, and the bill must
    //    agree with the order afterwards. A bill disagreeing with its source is
    //    the failure mode that matters, not which price won.
    const desk = { name: "Front Desk", role: "secretary" as const };
    await Promise.allSettled([
      setExternalLabSalePrice(v2.id, { totalSalePrice: 500 }, desk, { canSeeCost: false }),
      setExternalLabSalePrice(v2.id, { totalSalePrice: 600 }, desk, { canSeeCost: false }),
    ]);
    const order2 = await db.consultationExternalLabOrder.findFirstOrThrow({ where: { consultationId: v2.id } });
    const line2 = (await pendingLabLine(karl.id)).line;
    ok("race: concurrent repricings settle on one of the two prices",
       order2.totalSalePrice === 500 || order2.totalSalePrice === 600, `sale=${order2.totalSalePrice}`);
    ok("race: the basket line agrees with the order afterwards",
       line2?.unitPrice === order2.totalSalePrice,
       `line=${line2?.unitPrice} order=${order2.totalSalePrice}`);

    // -- a reprice racing the settlement. Either it lands first (and the patient
    //    pays the new price) or it is refused as settled. What must NEVER happen
    //    is a paid basket whose line disagrees with the order it billed.
    const basket2 = (await listVisitBaskets({ clientId: karl.id, status: "pending" }))[0];
    await Promise.allSettled([
      setExternalLabSalePrice(v2.id, { totalSalePrice: 777 }, desk, { canSeeCost: false }),
      settleVisitBasket(basket2.id, {
        splits: [{ method: "cash", amount: basket2.total }],
        actorName: "Front Desk",
      }),
    ]);
    const settled2 = await db.visitBasket.findUniqueOrThrow({
      where: { id: basket2.id },
      include: { items: true },
    });
    const finalOrder = await db.consultationExternalLabOrder.findFirstOrThrow({ where: { consultationId: v2.id } });
    const settledLine = settled2.items.find((i) => i.kind === "external_lab");
    if (settled2.status === "paid") {
      ok("race: a settled basket's line still agrees with its order",
         settledLine?.unitPrice === finalOrder.totalSalePrice,
         `line=${settledLine?.unitPrice} order=${finalOrder.totalSalePrice}`);
    } else {
      ok("race: settlement did not land; nothing is inconsistent", true, `status=${settled2.status}`);
    }
    ok("race: the order is frozen once its basket is settled",
       settled2.status !== "paid" ||
         (await getExternalLabOrder(v2.id, { canSeeCost: true }))?.settled === true);
  }

  // =====================================================================
  // 10. Reporting reconciles to the revenue breakdown
  // =====================================================================
  {
    // A third patient, priced differently for the SAME tests — the whole reason
    // this feature exists, and the thing per-order reporting has to survive.
    const mark = await db.client.create({
      data: { firstName: "Mark", lastName: "Lab", phone: "+96170123403" },
    });
    const v3 = await createConsultation(
      {
        clientId: mark.id,
        dietitianId: doc.id,
        waiveConsultationFee: true,
        externalLabOrder: labOrder([{ name: "Cholesterol" }, { name: "Vitamin D" }], 200, 800),
      },
      DOCTOR_PERMS,
    );
    const markBasket = (await listVisitBaskets({ clientId: mark.id, status: "pending" }))[0];

    // Before settlement: priced, but not revenue. Recognition is at settlement.
    const beforeSettle = await getExternalLabProfitability({});
    ok("report: a PENDING order is not counted as revenue",
       !beforeSettle.rows.some((r) => r.clientName === "Mark Lab"),
       `rows=${beforeSettle.rows.length}`);

    await settleVisitBasket(markBasket.id, {
      splits: [{ method: "cash", amount: markBasket.total }],
      actorName: "Front Desk",
    });

    const report = await getExternalLabProfitability({});
    const overall = await getProfitability({});
    const kindRow = overall.byKind.find((k) => k.kind === "external_lab");

    ok("report: totals reconcile EXACTLY to the external_lab revenue row",
       kindRow !== undefined && report.revenue === kindRow.revenue,
       `report=${report.revenue} breakdown=${kindRow?.revenue}`);
    ok("report: costs reconcile EXACTLY to the external_lab COGS row",
       kindRow !== undefined && report.cogs === kindRow.cogs,
       `report=${report.cogs} breakdown=${kindRow?.cogs}`);
    ok("report: profit is revenue - cost",
       report.grossProfit === Math.round((report.revenue - report.cogs) * 100) / 100,
       `${report.revenue} - ${report.cogs} = ${report.grossProfit}`);
    ok("report: per-order rows sum to the total",
       Math.round(report.rows.reduce((n, r) => n + r.revenue, 0) * 100) / 100 === report.revenue,
       `rows=${report.rows.map((r) => r.revenue).join("+")} total=${report.revenue}`);

    const markRow = report.rows.find((r) => r.clientName === "Mark Lab");
    ok("report: the settled order now appears", markRow !== undefined);
    ok("report: it carries its own cost and margin",
       markRow?.cogs === 200 && markRow?.grossProfit === 600,
       `cost=${markRow?.cogs} profit=${markRow?.grossProfit}`);
    ok("report: it lists the tests the order covered",
       markRow?.tests.join(",") === "Cholesterol,Vitamin D", markRow?.tests.join(","));
    // The premise of the whole feature: the same two tests, quoted differently by
    // the lab on different days, must report their OWN economics — not a shared
    // per-test rate. (Their gross profits can coincide; the cost and revenue that
    // produced them must not be assumed equal, which is what this asserts.)
    const johnRow = report.rows.find((r) => r.clientName === "John Lab");
    ok("report: same tests, different quote — John's own cost/revenue",
       johnRow?.cogs === 300 && johnRow?.revenue === 900,
       `cost=${johnRow?.cogs} revenue=${johnRow?.revenue}`);
    ok("report: same tests, different quote — Mark's own cost/revenue",
       markRow?.cogs === 200 && markRow?.revenue === 800,
       `cost=${markRow?.cogs} revenue=${markRow?.revenue}`);
    ok("report: the two identical orders are NOT priced alike",
       johnRow?.cogs !== markRow?.cogs && johnRow?.revenue !== markRow?.revenue,
       `${johnRow?.cogs}/${johnRow?.revenue} vs ${markRow?.cogs}/${markRow?.revenue}`);
    // John's line was $1000 with a 10% bill discount applied at checkout, so his
    // revenue proves the line's frozen share of that discount is honoured here.
    ok("report: a bill-level discount reduces the order's revenue, not its price",
       johnRow?.revenue === 900,
       `revenue=${johnRow?.revenue}`);

    // A closed visit's sale must stay in the books — `closed` is a retired
    // settled basket, not an un-sale. (The same rule as the freeze in §8.)
    const revenueBeforeClose = (await getExternalLabProfitability({})).revenue;
    await closeConsultation(v3.id, { actorName: "Dr L", actorEmail: doc.email, actorRole: "dietitian" });
    ok("report: closing the visit does not remove its revenue",
       (await getExternalLabProfitability({})).revenue === revenueBeforeClose,
       `before=${revenueBeforeClose} after=${(await getExternalLabProfitability({})).revenue}`);
  }

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await db.$disconnect();
});
