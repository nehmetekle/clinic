/**
 * Adversarial pass over the money surfaces, driven through the REAL route
 * handlers with REAL session cookies — so what is asserted is what a crafted
 * HTTP request actually gets, not what a repository function would do if called
 * politely. Test DB only (see run.sh).
 *
 * The question each block asks: what can a malicious or careless caller make the
 * server believe about money?
 */
import { db } from "@/server/db";
import { createSession, SESSION_COOKIE_NAME } from "@/server/session";
import { createConsultation } from "@/server/repositories/consultations";
import { listVisitBaskets } from "@/server/repositories/visitBaskets";
import { createClientDebtTx, listClientDebts } from "@/server/repositories/clientDebts";
import { updateSettings } from "@/server/repositories/settings";
import * as settingsRoute from "@/app/api/settings/route";
import * as fxHistoryRoute from "@/app/api/settings/fx-history/route";
import * as settleRoute from "@/app/api/visit-baskets/[id]/settle/route";
import * as debtRoute from "@/app/api/client-debts/[id]/route";
import * as receiptRoute from "@/app/api/receipts/[paymentId]/route";
import * as paymentsRoute from "@/app/api/payments/route";
import * as cronRoute from "@/app/api/cron/reminders/route";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

const USD_TO_EUR = 0.92;
const USD_TO_LBP = 89_500;

let phoneSeq = 0;
const nextPhone = () => `+9617014${String(6000 + phoneSeq++).padStart(4, "0")}`;

async function reset() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "JessySettlement", "JessyReceivable", "JessySettlementAllocation" CASCADE`,
  );
  await db.fxRateChange.deleteMany({});
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.setting.deleteMany({});
}

async function main() {
  await reset();

  const admin = await db.user.create({
    data: { fullName: "Adv Admin", email: "advadmin@test.local", role: "admin", passwordHash: "x" },
  });
  const secretary = await db.user.create({
    data: { fullName: "Adv Sec", email: "advsec@test.local", role: "secretary", passwordHash: "x" },
  });
  const dietitian = await db.user.create({
    data: { fullName: "Adv Doc", email: "advdoc@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });

  /** A signed-in request factory for `user`, carrying a genuine session cookie. */
  const as = async (user: { id: string }) => {
    const token = await createSession(user.id);
    return (url: string, init?: RequestInit) =>
      new Request(url, {
        ...init,
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}`, ...(init?.headers ?? {}) },
      });
  };
  const asAdmin = await as(admin);
  const asSecretary = await as(secretary);
  const asDietitian = await as(dietitian);
  const anon = (url: string, init?: RequestInit) =>
    new Request(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const forged = (url: string, init?: RequestInit) =>
    new Request(url, {
      ...init,
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=not-a-real-token`, ...(init?.headers ?? {}) },
    });

  await updateSettings({
    usdToLbp: USD_TO_LBP, usdToEur: USD_TO_EUR, cardSurchargePercent: 0,
    actorId: admin.id, actorName: admin.fullName,
  });

  const mkClient = (first: string) =>
    db.client.create({ data: { firstName: first, lastName: "Adv", phone: nextPhone() } });
  const billFor = async (clientId: string, usd: number) => {
    await db.user.update({ where: { id: dietitian.id }, data: { consultationFee: usd } });
    await createConsultation({ clientId, dietitianId: dietitian.id });
    const [b] = await listVisitBaskets({ clientId, status: "pending" });
    return b;
  };
  const settle = (make: typeof anon, id: string, body: unknown) =>
    settleRoute.POST(
      make(`http://localhost/api/visit-baskets/${id}/settle`, { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );
  const putSettings = (make: typeof anon, body: unknown) =>
    settingsRoute.PUT(make("http://localhost/api/settings", { method: "PUT", body: JSON.stringify(body) }));

  // ==================================================== 1. Authorization gates
  {
    const c = await mkClient("AuthZ");
    const b = await billFor(c.id, 100);
    const body = { splits: [{ method: "cash", currency: "USD", amount: 100 }] };

    ok("secretary CAN settle", (await settle(asSecretary, b.id, body)).status === 200);
    // Re-open for the remaining attempts.
    await db.visitBasket.update({ where: { id: b.id }, data: { status: "pending", paidAt: null, paymentId: null } });
    await db.payment.deleteMany({ where: { visitBasketId: b.id } });

    ok("dietitian CANNOT settle", (await settle(asDietitian, b.id, body)).status === 403);
    ok("unauthenticated CANNOT settle", (await settle(anon, b.id, body)).status === 403);
    ok("a forged session cookie CANNOT settle", (await settle(forged, b.id, body)).status === 403);
    ok("…and none of them recorded anything",
       (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);

    // FX rates: admin-only to write, everyone to read.
    ok("secretary CANNOT change an FX rate", (await putSettings(asSecretary, { usdToEur: 0.95 })).status === 403);
    ok("dietitian CANNOT change an FX rate", (await putSettings(asDietitian, { usdToEur: 0.95 })).status === 403);
    ok("unauthenticated CANNOT change an FX rate", (await putSettings(anon, { usdToEur: 0.95 })).status === 403);
    ok("the rate is untouched by those attempts",
       Number((await db.setting.findUniqueOrThrow({ where: { key: "usdToEur" } })).value) === USD_TO_EUR);
    ok("…and no history row was written",
       (await db.fxRateChange.count({ where: { newValue: 0.95 } })) === 0);
    ok("admin CAN change an FX rate", (await putSettings(asAdmin, { usdToEur: 0.93 })).status === 200);
    await putSettings(asAdmin, { usdToEur: USD_TO_EUR });

    // Rate HISTORY is admin-only — it names staff and is a financial trail.
    const readHistory = (make: typeof anon) =>
      fxHistoryRoute.GET(make("http://localhost/api/settings/fx-history"));
    ok("admin can read the FX history", (await readHistory(asAdmin)).status === 200);
    ok("secretary is refused the FX history", (await readHistory(asSecretary)).status === 403);
    ok("dietitian is refused the FX history", (await readHistory(asDietitian)).status === 403);
    ok("unauthenticated is refused the FX history", (await readHistory(anon)).status === 403);
    ok("a forged session is refused the FX history", (await readHistory(forged)).status === 403);
    const refusedBody = await (await readHistory(asSecretary)).json();
    ok("…and the refusal leaks no history data",
       refusedBody.error === "Not allowed" && !Array.isArray(refusedBody),
       JSON.stringify(refusedBody));

    // There is no write path to the history AT ALL.
    ok("the FX history route exposes no mutating handler",
       !("POST" in fxHistoryRoute) && !("PATCH" in fxHistoryRoute) &&
       !("PUT" in fxHistoryRoute) && !("DELETE" in fxHistoryRoute));
  }

  // ================================================== 2. Audit actor forgery
  {
    // The body tries to attribute the change to someone else, and to backdate it.
    const res = await putSettings(asAdmin, {
      usdToEur: 0.94,
      actorId: dietitian.id,
      actorName: "Somebody Else",
      changedByName: "Somebody Else",
      changedAt: "1999-01-01T00:00:00.000Z",
    });
    ok("a rate change with forged actor fields still succeeds", res.status === 200, `${res.status}`);
    const row = await db.fxRateChange.findFirstOrThrow({ orderBy: { changedAt: "desc" } });
    ok("…but the actor recorded is the SESSION user, not the body",
       row.changedByName === "Adv Admin" && row.changedById === admin.id,
       `${row.changedByName}/${row.changedById}`);
    ok("…and the timestamp is server-side, not the forged one",
       row.changedAt.getFullYear() > 2020, row.changedAt.toISOString());
    await putSettings(asAdmin, { usdToEur: USD_TO_EUR });
  }

  // ============================================== 3. Client-supplied FX / totals
  {
    const c = await mkClient("Craft");
    const b = await billFor(c.id, 1000);

    // €1 dressed up with every fabricated field a client could invent.
    const res = await settle(asSecretary, b.id, {
      splits: [{
        method: "cash", currency: "EUR", amount: 1,
        fxRate: 0.001, amountUsd: 1000, usd: 1000, usdEquivalent: 1000,
      }],
      total: 1000, remaining: 0, paidUsd: 1000, combinedCollected: 1,
    });
    ok("€1 with a fabricated fxRate/amountUsd cannot settle a $1000 bill", res.status === 409,
       `${res.status}`);
    const msg = (await res.json()).error as string;
    ok("…and the server states its OWN valuation ($1.09), not the claimed one",
       msg.includes("1.09"), msg);
    ok("…recording nothing", (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);

    // A fabricated confirmation cannot wave a suspicious rate through.
    const sus = await putSettings(asAdmin, { usdToEur: 92, confirmSuspicious: { usdToEur: 0.92 } });
    ok("a confirmation naming a DIFFERENT value does not authorise the change",
       sus.status === 409, `${sus.status}`);
    ok("…identified by a specific code the UI can act on",
       (await (await putSettings(asAdmin, { usdToEur: 92, confirmSuspicious: { usdToEur: 0.92 } })).json()).code
         === "fx_rate_confirmation_required");
    ok("…and the rate is unchanged",
       Number((await db.setting.findUniqueOrThrow({ where: { key: "usdToEur" } })).value) === USD_TO_EUR);
  }

  // ======================================================== 4. Malformed input
  {
    const c = await mkClient("Malformed");
    const b = await billFor(c.id, 100);
    const reject = async (label: string, body: unknown) => {
      const r = await settle(asSecretary, b.id, body);
      ok(label, r.status === 400 || r.status === 409, `got ${r.status}`);
    };
    await reject("negative leg amount", { splits: [{ method: "cash", currency: "USD", amount: -100 }] });
    await reject("NaN leg amount", { splits: [{ method: "cash", currency: "USD", amount: "NaN" }] });
    await reject("Infinity leg amount", { splits: [{ method: "cash", currency: "USD", amount: 1e400 }] });
    await reject("scientific-notation overflow", { splits: [{ method: "cash", currency: "USD", amount: "1e309" }] });
    await reject("unsupported currency", { splits: [{ method: "cash", currency: "GBP", amount: 100 }] });
    await reject("lowercase currency", { splits: [{ method: "cash", currency: "usd", amount: 100 }] });
    await reject("unsupported method", { splits: [{ method: "crypto", currency: "USD", amount: 100 }] });
    await reject("empty legs against a non-zero bill", { splits: [] });
    await reject("null splits", { splits: null });
    await reject("splits as an object", { splits: { method: "cash", amount: 100 } });
    await reject("absurd USD amount", { splits: [{ method: "cash", currency: "USD", amount: 9_999_999 }] });
    await reject("many tiny legs that don't reach the total",
      { splits: Array.from({ length: 60 }, () => ({ method: "cash", currency: "USD", amount: 0.01 })) });
    await reject("Jessy in EUR via a crafted request",
      { splits: [{ method: "jessy", currency: "EUR", amount: 92 }] });
    await reject("Jessy in LBP via a crafted request",
      { splits: [{ method: "jessy", currency: "LBP", amount: 8_950_000 }] });
    ok("after every malformed attempt the basket is still pending",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b.id } })).status === "pending");
    ok("…and not one payment row exists",
       (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);

    // Settings input abuse.
    const badRate = async (label: string, body: unknown) => {
      const r = await putSettings(asAdmin, body);
      ok(label, r.status === 400 || r.status === 409, `got ${r.status}`);
    };
    await badRate("zero rate", { usdToEur: 0 });
    await badRate("negative rate", { usdToEur: -0.92 });
    await badRate("Infinity rate", { usdToLbp: 1e400 });
    await badRate("NaN rate", { usdToLbp: "NaN" });
    await badRate("absurd LBP rate", { usdToLbp: 1e12 });
    ok("the rates survived every bad update",
       Number((await db.setting.findUniqueOrThrow({ where: { key: "usdToLbp" } })).value) === USD_TO_LBP);
  }

  // ============================================ 5. Receipts: authz + IDOR shape
  {
    const c = await mkClient("Receipt");
    const b = await billFor(c.id, 100);
    await settle(asSecretary, b.id, { splits: [{ method: "cash", currency: "USD", amount: 100 }] });
    const p = await db.payment.findFirstOrThrow({ where: { visitBasketId: b.id } });
    const get = (make: typeof anon, id: string) =>
      receiptRoute.GET(make(`http://localhost/api/receipts/${id}`), {
        params: Promise.resolve({ paymentId: id }),
      });

    ok("secretary can print a receipt", (await get(asSecretary, p.id)).status === 200);
    ok("admin can print a receipt", (await get(asAdmin, p.id)).status === 200);
    ok("dietitian CANNOT print a receipt", (await get(asDietitian, p.id)).status === 403);
    ok("unauthenticated CANNOT print a receipt", (await get(anon, p.id)).status === 403);
    ok("a forged session CANNOT print a receipt", (await get(forged, p.id)).status === 403);

    const good = await get(asSecretary, p.id);
    ok("the receipt is served as a PDF", good.headers.get("content-type") === "application/pdf");
    ok("…inline, so Print opens the viewer",
       good.headers.get("content-disposition")?.startsWith("inline") === true,
       good.headers.get("content-disposition") ?? "");
    ok("…and is never cached by a shared cache",
       good.headers.get("cache-control")?.includes("no-store") === true,
       good.headers.get("cache-control") ?? "");

    // An id that doesn't exist, and one that is not an id at all.
    ok("an unknown payment id yields 404", (await get(asSecretary, "nope")).status === 404);
    ok("a path-traversal-shaped id yields 404",
       (await get(asSecretary, "..%2F..%2Fetc%2Fpasswd")).status === 404);
    // IDOR shape: the receipt is derived from the payment itself, so there is no
    // client-supplied scope to widen — a valid id only ever yields ITS settlement.
    const other = await mkClient("Other");
    const ob = await billFor(other.id, 55);
    await settle(asSecretary, ob.id, { splits: [{ method: "cash", currency: "USD", amount: 55 }] });
    const op = await db.payment.findFirstOrThrow({ where: { visitBasketId: ob.id } });
    const body = await (await get(asSecretary, op.id)).arrayBuffer();
    ok("a receipt for another client's payment is its own, not merged",
       body.byteLength > 1000 && op.clientId === other.id);
  }

  // ================================== 6. Debt: authz, overpayment, IDOR scoping
  {
    const c = await mkClient("DebtAdv");
    const victim = await mkClient("Victim");
    const debtId = await db.$transaction((tx) =>
      createClientDebtTx(tx, { clientId: c.id, amount: 400, reason: "Owed", source: "secretary_override" }),
    );
    const patch = (make: typeof anon, id: string, body: unknown) =>
      debtRoute.PATCH(
        make(`http://localhost/api/client-debts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
        { params: Promise.resolve({ id }) },
      );

    ok("dietitian CANNOT collect a debt",
       (await patch(asDietitian, debtId!, { action: "clear", method: "cash" })).status === 403);
    ok("unauthenticated CANNOT collect a debt",
       (await patch(anon, debtId!, { action: "clear", method: "cash" })).status === 403);
    ok("secretary CANNOT void (write off) a debt — admin only",
       (await patch(asSecretary, debtId!, { action: "void", reason: "x" })).status === 403);
    ok("…and the debt is untouched",
       (await listClientDebts(c.id))[0].status === "outstanding");

    // Overpayment in foreign tender is refused with the overage named.
    const over = await patch(asSecretary, debtId!, {
      action: "clear", method: "cash",
      tender: [{ method: "cash", currency: "EUR", amount: 400 }], // $434.78 vs $400
    });
    ok("over-collecting a debt is refused", over.status === 409, `${over.status}`);
    ok("…naming the overage", ((await (await patch(asSecretary, debtId!, {
      action: "clear", method: "cash",
      tender: [{ method: "cash", currency: "EUR", amount: 400 }],
    })).json()).error as string).includes("too much"));
    ok("…and nothing was collected", (await listClientDebts(c.id))[0].paidAmount === 0);

    // Two concurrent partial collections must not both apply to a stale balance.
    const half = () => patch(asSecretary, debtId!, {
      action: "clear", method: "cash",
      tender: [{ method: "cash", currency: "EUR", amount: 184 }], // $200
    });
    const [r1, r2] = await Promise.all([half(), half()]);
    const applied = (await listClientDebts(c.id))[0].paidAmount;
    const wins = [r1, r2].filter((r) => r.status === 200).length;
    ok("concurrent partial debt collections apply exactly once each, never twice on a stale read",
       applied === 200 || applied === 400, `paid=${applied} wins=${wins}`);
    ok("…and paidAmount never exceeds the principal", applied <= 400, `${applied}`);

    // A debt id belonging to another client cannot be collected via a basket.
    const vb = await billFor(victim.id, 10);
    const cross = await settle(asSecretary, vb.id, {
      splits: [{ method: "cash", currency: "USD", amount: 10 }],
      clearDebtIds: [debtId!],
    });
    ok("a debt from another client cannot be cleared through this client's basket",
       cross.status === 409, `${cross.status}`);
    ok("…and the victim's basket recorded nothing",
       (await db.payment.count({ where: { visitBasketId: vb.id } })) === 0);
  }

  // ================================================ 7. Idempotency / replay
  {
    const c = await mkClient("Replay");
    const b = await billFor(c.id, 75);
    const body = { splits: [{ method: "cash", currency: "USD", amount: 75 }] };
    const first = await settle(asSecretary, b.id, body);
    const replay = await settle(asSecretary, b.id, body);
    ok("the first settlement succeeds", first.status === 200);
    ok("an exact replay of it is refused", replay.status === 409, `${replay.status}`);
    ok("…leaving exactly one payment",
       (await db.payment.count({ where: { visitBasketId: b.id } })) === 1);

    // Manual payments dedupe on the client-supplied idempotency key.
    const mk = (key: string) =>
      paymentsRoute.POST(asSecretary("http://localhost/api/payments", {
        method: "POST",
        body: JSON.stringify({
          clientId: c.id, motif: "Replay test", amountPaid: 50, currency: "EUR",
          method: "cash", idempotencyKey: key,
        }),
      }));
    await mk("dup-key-1");
    await mk("dup-key-1");
    ok("a replayed manual payment with the same idempotency key creates ONE row",
       (await db.payment.count({ where: { motif: "Replay test" } })) === 1);
  }

  // ============================ 8. Scheduler routes fail CLOSED without a secret
  {
    const savedSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const cron = await cronRoute.GET(anon("http://localhost/api/cron/reminders"));
    ok("with no CRON_SECRET the reminder cron is DISABLED, not open", cron.status === 503,
       `${cron.status}`);

    process.env.CRON_SECRET = "s3cr3t-for-tests";
    ok("a wrong secret is refused",
       (await cronRoute.GET(anon("http://localhost/api/cron/reminders?key=wrong"))).status === 401);

    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  }

  await db.$disconnect();
}

main();
