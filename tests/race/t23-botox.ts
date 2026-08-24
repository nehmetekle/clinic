/**
 * Botox: admin-priced catalog, doctor-overridden per-visit charge, locked the
 * moment any part of it is paid. Test DB only (see run.sh).
 *
 * Locks in the invariants the feature rests on:
 *   - only admin or a specifically-granted dietitian may add/change a line —
 *     enforced server-side (buildBotoxLinesTx), not just hidden in the UI;
 *   - the doctor's charged price is free-form (above OR below the catalog
 *     base), with no percentage bound;
 *   - a price override is audited with the exact base->charged values, once —
 *     re-saving an unchanged line never spams the log;
 *   - THE CORE REGRESSION: once a line is paid, re-pricing it on a later save
 *     is REFUSED rather than silently opening a second, additional charge for
 *     the same line (the double-charge this feature could otherwise cause,
 *     because a doctor-editable price breaks the app's normal price-in-
 *     signature basket netting — see the model comment on
 *     ConsultationBotoxItem);
 *   - a paid line can't be dropped from the save either;
 *   - the secretary can settle a Botox line like any other basket charge, but
 *     can't re-price OR invent one at checkout (updateVisitBasket);
 *   - an unauthorized save that never touches the section (`botoxItems`
 *     omitted) leaves existing lines untouched — it must never read as
 *     "clear them out";
 *   - a hard-deleted catalog item doesn't corrupt or lock out a visit that
 *     already charged from it.
 */
import { db } from "@/server/db";
import { createConsultation, updateConsultation, closeConsultation } from "@/server/repositories/consultations";
import { listVisitBaskets, settleVisitBasket, updateVisitBasket } from "@/server/repositories/visitBaskets";

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

async function main() {
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultationBotoxItem.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.botoxItem.deleteMany({});

  const admin = await db.user.create({
    data: { fullName: "Admin A", email: "admin@test.local", role: "admin", passwordHash: "x" },
  });
  const docBotox = await db.user.create({
    data: {
      fullName: "Dr Granted", email: "granted@test.local", role: "dietitian", passwordHash: "x",
      canOfferBotox: true, consultationFee: 0,
    },
  });
  const docNoBotox = await db.user.create({
    data: {
      fullName: "Dr Ungranted", email: "ungranted@test.local", role: "dietitian", passwordHash: "x",
      canOfferBotox: false, consultationFee: 0,
    },
  });

  const forehead = await db.botoxItem.create({
    data: { name: "Forehead", price: 100, cost: 10, currency: "USD", active: true },
  });

  const mkClient = (n: string, phone: string) =>
    db.client.create({ data: { firstName: n, lastName: "Case", phone } });

  // =====================================================================
  // 1. Permission: only admin or a specifically-granted doctor may add a line
  // =====================================================================
  const c1 = await mkClient("Perm", "+96170100001");
  await expectFailure(
    "unauthorized dietitian cannot create a visit with a Botox line",
    () =>
      createConsultation(
        { clientId: c1.id, dietitianId: docNoBotox.id, waiveConsultationFee: true,
          botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 100 }] },
        { actorName: docNoBotox.fullName, actorEmail: docNoBotox.email, actorCanOfferBotox: false },
      ),
    /not authorized/i,
  );
  ok("rejected create left no consultation behind",
     (await db.consultation.count({ where: { clientId: c1.id } })) === 0);

  const grantedOk = await createConsultation(
    { clientId: c1.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 100 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorCanOfferBotox: true },
  );
  ok("granted dietitian can create a Botox line", grantedOk.botoxItems?.length === 1);
  await db.consultation.delete({ where: { id: grantedOk.id } });

  const adminOk = await createConsultation(
    { clientId: c1.id, dietitianId: admin.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 100 }] },
    { actorName: admin.fullName, actorEmail: admin.email, actorCanOfferBotox: true },
  );
  ok("admin can always create a Botox line", adminOk.botoxItems?.length === 1);
  await db.consultation.delete({ where: { id: adminOk.id } });

  // =====================================================================
  // 2. Free-form price override (above and below base), frozen basePrice,
  //    and exactly one audit entry
  // =====================================================================
  const c2 = await mkClient("Override", "+96170100002");
  const v2 = await createConsultation(
    { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 110 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorCanOfferBotox: true },
  );
  const line2 = v2.botoxItems?.[0];
  ok("charged price is what the doctor entered, above base", line2?.chargedPrice === 110, `charged=${line2?.chargedPrice}`);
  ok("base price kept as reference, untouched", line2?.basePrice === 100, `base=${line2?.basePrice}`);
  ok("line starts unpaid", line2?.paid === false);

  const [basket2] = await listVisitBaskets({ clientId: c2.id, status: "pending" });
  ok("basket bills the CHARGED price, not the base", basket2?.total === 110, `total=${basket2?.total}`);

  const auditRows2 = await db.auditLog.findMany({ where: { action: "Botox price overridden" } });
  ok("exactly one audit entry for the override", auditRows2.length === 1, `count=${auditRows2.length}`);
  ok("audit entry names both figures",
     /base USD 100/.test(auditRows2[0]?.entityLabel ?? "") && /charged USD 110/.test(auditRows2[0]?.entityLabel ?? ""),
     auditRows2[0]?.entityLabel);

  // Re-saving the SAME unchanged line must not spam the audit log.
  await updateConsultation(
    v2.id,
    { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ id: line2!.id, botoxItemId: forehead.id, chargedPrice: 110 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
  );
  ok("re-saving an unchanged price adds no new audit entry",
     (await db.auditLog.count({ where: { action: "Botox price overridden" } })) === 1);

  // A legitimate BELOW-base override (no lower bound, per spec).
  const c2b = await mkClient("Below", "+96170100022");
  const v2b = await createConsultation(
    { clientId: c2b.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 90 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorCanOfferBotox: true },
  );
  ok("a below-base charge is accepted with no percentage bound", v2b.botoxItems?.[0]?.chargedPrice === 90);

  // =====================================================================
  // 3. THE CORE REGRESSION: paid line can't be re-priced or dropped later
  // =====================================================================
  await settleVisitBasket(basket2.id, { splits: [{ method: "cash", amount: 110 }], actorName: "Sec" });
  ok("basket now paid", (await db.visitBasket.findUniqueOrThrow({ where: { id: basket2.id } })).status === "paid");

  await expectFailure(
    "a paid Botox line CANNOT be re-priced on a later save",
    () =>
      updateConsultation(
        v2.id,
        { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true,
          botoxItems: [{ id: line2!.id, botoxItemId: forehead.id, chargedPrice: 999 }] },
        { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
      ),
    /already been settled/i,
  );
  // The regression this guards: without the lock, that rejected edit would
  // instead have opened a SECOND charge for the same line (see the model
  // comment on ConsultationBotoxItem). Prove no such charge exists.
  ok("no duplicate payment was created", (await db.payment.count({ where: { clientId: c2.id } })) === 1);
  ok("no new pending basket was created",
     (await listVisitBaskets({ clientId: c2.id, status: "pending" })).length === 0);
  ok("the paid line's charge is still exactly $110",
     (await db.consultationBotoxItem.findUniqueOrThrow({ where: { id: line2!.id } })).chargedPrice === 110);

  await expectFailure(
    "a paid Botox line CANNOT be dropped from a later save",
    () =>
      updateConsultation(
        v2.id,
        { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true, botoxItems: [] },
        { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
      ),
    /already been settled/i,
  );
  ok("the line still exists after the refused drop",
     (await db.consultationBotoxItem.count({ where: { id: line2!.id } })) === 1);

  // A brand-new, still-unpaid line CAN be added alongside the locked one.
  const v2reload = await updateConsultation(
    v2.id,
    { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [
        { id: line2!.id, botoxItemId: forehead.id, chargedPrice: 110 },
        { botoxItemId: forehead.id, chargedPrice: 120 },
      ] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
  );
  ok("a new unpaid line can be added beside a locked one", v2reload.botoxItems?.length === 2);
  const [basket2new] = await listVisitBaskets({ clientId: c2.id, status: "pending" });
  ok("only the NEW line's amount is newly due, not the paid one too",
     basket2new?.total === 120, `total=${basket2new?.total}`);

  // =====================================================================
  // 4. Unauthorized save omitting `botoxItems` must not wipe existing lines
  // =====================================================================
  const beforeCount = await db.consultationBotoxItem.count({ where: { consultationId: v2.id } });
  await updateConsultation(
    v2.id,
    { clientId: c2.id, dietitianId: docBotox.id, notes: "unrelated clinical note", waiveConsultationFee: true },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: false },
  );
  ok("omitting botoxItems on a save leaves existing lines untouched even without permission",
     (await db.consultationBotoxItem.count({ where: { consultationId: v2.id } })) === beforeCount,
     `before=${beforeCount} after=${await db.consultationBotoxItem.count({ where: { consultationId: v2.id } })}`);
  // The pending basket is rebuilt from scratch on EVERY save, so this is the
  // exact case that would silently drop an already-unpaid Botox charge from
  // what the secretary sees, even with the row itself untouched.
  const [basket2after] = await listVisitBaskets({ clientId: c2.id, status: "pending" });
  ok("the still-unpaid Botox charge stays on the pending basket after an unrelated save",
     basket2after?.total === 120, `total=${basket2after?.total}`);

  // =====================================================================
  // 5. Closed-visit immutability
  // =====================================================================
  await settleVisitBasket(basket2new.id, { splits: [{ method: "cash", amount: 120 }], actorName: "Sec" });
  await closeConsultation(v2.id, { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian" });
  await expectFailure(
    "a closed visit refuses ANY edit, Botox included",
    () =>
      updateConsultation(
        v2.id,
        { clientId: c2.id, dietitianId: docBotox.id, waiveConsultationFee: true,
          botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 50 }] },
        { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
      ),
    /closed/i,
  );

  // =====================================================================
  // 6. Secretary at checkout: can settle a Botox line, cannot re-price or
  //    invent one
  // =====================================================================
  const c3 = await mkClient("Checkout", "+96170100003");
  await createConsultation(
    { clientId: c3.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: forehead.id, chargedPrice: 100 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorCanOfferBotox: true },
  );
  const [basket3] = await listVisitBaskets({ clientId: c3.id, status: "pending" });
  const botoxLine3 = basket3.items.find((i) => i.kind === "botox")!;
  ok("botox line reaches the basket with its ConsultationBotoxItem link",
     Boolean(botoxLine3?.consultationBotoxItemId));

  const sameBotoxLine = {
    kind: "botox" as const,
    label: botoxLine3.label,
    quantity: botoxLine3.quantity,
    unitPrice: botoxLine3.unitPrice,
    currency: botoxLine3.currency,
    covered: botoxLine3.covered,
    consultationBotoxItemId: botoxLine3.consultationBotoxItemId,
  };
  await expectFailure(
    "secretary cannot re-price a Botox line at checkout",
    () =>
      updateVisitBasket(
        basket3.id,
        { items: [{ ...sameBotoxLine, unitPrice: 1 }] },
        { name: "Sec", role: "secretary" },
      ),
    /can't be re-priced at checkout/i,
  );
  await expectFailure(
    "secretary cannot invent a brand-new Botox line at checkout",
    () =>
      updateVisitBasket(
        basket3.id,
        {
          items: [
            sameBotoxLine,
            { kind: "botox", label: "Fabricated Botox", quantity: 1, unitPrice: 500, currency: "USD", covered: false },
          ],
        },
        { name: "Sec", role: "secretary" },
      ),
    /set by the doctor in the consultation/i,
  );
  // The legitimate settle still works after both refusals.
  await settleVisitBasket(basket3.id, { splits: [{ method: "cash", amount: 100 }], actorName: "Sec" });
  ok("legitimate settlement of a Botox basket still succeeds",
     (await db.visitBasket.findUniqueOrThrow({ where: { id: basket3.id } })).status === "paid");

  // =====================================================================
  // 7. A hard-deleted catalog item doesn't corrupt or lock out the visit
  // =====================================================================
  const c4 = await mkClient("Deleted", "+96170100004");
  const cheek = await db.botoxItem.create({ data: { name: "Cheek", price: 80, currency: "USD", active: true } });
  const v4 = await createConsultation(
    { clientId: c4.id, dietitianId: docBotox.id, waiveConsultationFee: true,
      botoxItems: [{ botoxItemId: cheek.id, chargedPrice: 80 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorCanOfferBotox: true },
  );
  const [basket4] = await listVisitBaskets({ clientId: c4.id, status: "pending" });
  await settleVisitBasket(basket4.id, { splits: [{ method: "cash", amount: 80 }], actorName: "Sec" });
  await db.botoxItem.delete({ where: { id: cheek.id } });
  ok("catalog item hard-delete nulls the FK but keeps the frozen name/price",
     (await db.consultationBotoxItem.findUniqueOrThrow({ where: { id: v4.botoxItems![0].id! } })).botoxItemId === null);

  // Saving something UNRELATED on this visit (still resending the paid,
  // now catalog-orphaned line, as the real editor always would) must still
  // succeed — this is the exact bug a botoxItemId-inclusive match would cause.
  const v4reload = await updateConsultation(
    v4.id,
    { clientId: c4.id, dietitianId: docBotox.id, notes: "follow-up note", waiveConsultationFee: true,
      botoxItems: [{ id: v4.botoxItems![0].id, chargedPrice: 80 }] },
    { actorName: docBotox.fullName, actorEmail: docBotox.email, actorRole: "dietitian", actorCanOfferBotox: true },
  );
  ok("a visit survives its Botox catalog item being deleted",
     v4reload.botoxItems?.[0]?.chargedPrice === 80 && v4reload.notes === "follow-up note");

  // =====================================================================
  // 8. Revenue reporting picks up "botox" with no extra wiring
  // =====================================================================
  const byKind = await db.$queryRawUnsafe<{ kind: string }[]>(
    `SELECT DISTINCT "kind" FROM "VisitBasketItem" WHERE "kind" = 'botox'`,
  );
  ok("botox basket lines are a real, generically-reportable kind", byKind.length === 1);

  await db.$disconnect();
}
main();
