import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError } from "../http";
import { calcBmi, discountAmount } from "@/lib/utils";
import { allocateCoverage } from "@/lib/coverage";
import { clinicDayRange } from "@/lib/config";
import { asCurrency, dateOnly } from "../serialize";
import { auditMoney, writeAudit } from "./audit";
import {
  createSettledBasketTx,
  upsertPendingBasketTx,
  type BasketItemInput,
} from "./visitBaskets";
import { reconcileVisitBloodSampleTx } from "./bloodSamples";
import { userIdByEmail } from "./staff";
import type {
  Consultation,
  ConsultationBloodTestCharge,
  ConsultationListItem,
  ConsultationServiceTotal,
  ConsultationStatus,
  Currency,
} from "@/lib/types";

export const consultationInclude = {
  client: true,
  dietitian: true,
  treatments: { include: { clientPackage: true }, orderBy: { createdAt: "asc" } },
  products: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ConsultationInclude;

const include = consultationInclude;

type ConsultationRow = Prisma.ConsultationGetPayload<{ include: typeof include }>;

/** Tolerant parse of a JSON-encoded string[] column. */
function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Tolerant parse of saved service price snapshots. */
function parseCharges(value: string | null): ConsultationBloodTestCharge[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        name: String(item?.name ?? ""),
        price: Number(item?.price ?? 0),
        currency: asCurrency(String(item?.currency ?? "USD")),
      }))
      .filter((item) => item.name);
  } catch {
    return [];
  }
}

function parseServiceTotals(value: string | null): ConsultationServiceTotal[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        currency: asCurrency(String(item?.currency ?? "USD")),
        subtotal: Number(item?.subtotal ?? 0),
        discount: Number(item?.discount ?? 0),
        total: Number(item?.total ?? 0),
      }))
      .filter((item) => item.subtotal > 0 || item.discount > 0 || item.total > 0);
  } catch {
    return [];
  }
}

type PriceRow = { kind: string; key: string; price: number; currency: string };

function priceSnapshot(
  prices: PriceRow[],
  kind: "blood_test" | "treatment",
  key: string,
  name: string,
) {
  const row =
    prices.find((p) => p.kind === kind && p.key === key) ??
    prices.find((p) => p.kind === kind && p.key === "Other");
  return {
    name,
    price: row?.price ?? 0,
    currency: asCurrency(row?.currency ?? "USD"),
  };
}

function addMoney(totals: Record<string, number>, currency: Currency, amount: number) {
  if (amount <= 0) return;
  totals[currency] = (totals[currency] ?? 0) + amount;
}

function applyDiscount(input: {
  subtotals: Record<string, number>;
  discountType?: "percent" | "amount";
  discountValue?: number;
  discountCurrency?: Currency;
}): ConsultationServiceTotal[] {
  const entries = Object.entries(input.subtotals);

  return entries.map(([currency, subtotal]) => {
    // A percent applies to every currency bucket; a fixed amount only to the
    // bucket it was entered in. The magnitude comes from the shared discount rule.
    const applies =
      input.discountType === "percent" ||
      (input.discountType === "amount" &&
        currency === (input.discountCurrency ?? entries[0]?.[0]));
    const discount = applies
      ? discountAmount(subtotal, input.discountType, input.discountValue)
      : 0;

    return {
      currency: asCurrency(currency),
      subtotal,
      discount,
      total: Math.max(0, subtotal - discount),
    };
  });
}

export function toConsultation(c: ConsultationRow): Consultation {
  return {
    id: c.id,
    clientId: c.clientId,
    dietitianName: c.dietitian?.fullName ?? "Unassigned",
    date: dateOnly(c.date)!,
    visitNumber: c.visitNumber,
    status: c.status as Consultation["status"],
    weightKg: c.weightKg ?? undefined,
    heightCm: c.heightCm ?? undefined,
    bmi: c.bmi ?? undefined,
    waistCm: c.waistCm ?? undefined,
    hipsCm: c.hipsCm ?? undefined,
    bodyFatPercent: c.bodyFatPercent ?? undefined,
    muscleMassKg: c.muscleMassKg ?? undefined,
    goalWeightKg: c.goalWeightKg ?? undefined,
    clientGoals: c.clientGoals ?? undefined,
    notes: c.notes ?? undefined,
    recommendations: c.recommendations ?? undefined,
    followUpPlan: c.followUpPlan ?? undefined,
    bloodCollection: c.bloodCollection,
    bloodTests: parseList(c.bloodTests),
    bloodTestCharges: parseCharges(c.bloodTestCharges),
    nurseRequired: c.nurseRequired,
    visitDiscountType: (c.visitDiscountType ?? undefined) as Consultation["visitDiscountType"],
    visitDiscountValue: c.visitDiscountValue,
    visitDiscountReason: c.visitDiscountReason ?? undefined,
    visitDiscountCurrency: c.visitDiscountCurrency ? asCurrency(c.visitDiscountCurrency) : undefined,
    visitServiceTotals: parseServiceTotals(c.visitServiceTotals),
    consultationFee: c.consultationFee ?? undefined,
    consultationFeeWaived: c.consultationFeeWaived,
    treatments: c.treatments.map((t) => ({
      id: t.id,
      machine: t.machine,
      machineOther: t.machineOther ?? undefined,
      bodyParts: parseList(t.bodyParts),
      sessionsNeeded: t.sessionsNeeded,
      sessionsUsed: t.sessionsUsed,
      price: t.price,
      currency: asCurrency(t.currency),
      clientPackageId: t.clientPackageId ?? undefined,
      packageName: t.clientPackage?.packageName ?? undefined,
      sessionPlanId: t.sessionPlanId ?? undefined,
      notes: t.notes ?? undefined,
    })),
    products: c.products.map((p) => ({
      id: p.id,
      productId: p.productId ?? undefined,
      name: p.name,
      quantity: p.quantity,
      amount: p.amount,
      unitPrice: p.unitPrice,
      currency: asCurrency(p.currency),
      notes: p.notes ?? undefined,
    })),
  };
}

export async function listConsultations(
  filter: { clientId?: string; status?: ConsultationStatus; date?: string } = {},
): Promise<ConsultationListItem[]> {
  // Server-side filtering keeps callers (the queue especially) from pulling every
  // consultation ever recorded — they ask only for the status/day they render.
  const where: Prisma.ConsultationWhereInput = {};
  if (filter.clientId) where.clientId = filter.clientId;
  if (filter.status) where.status = filter.status;
  // Clinic-day range: selects rows whose clinicDay() equals `day`, matching the
  // `date` string the client compares against (even for a visit recorded just
  // after clinic-midnight, whose UTC day differs).
  if (filter.date) where.date = clinicDayRange(filter.date);
  const rows = await db.consultation.findMany({
    where,
    include,
    orderBy: { date: "desc" },
  });
  return rows.map((c) => ({
    ...toConsultation(c),
    clientName: `${c.client.firstName} ${c.client.lastName}`,
  }));
}

export type ConsultationInput = {
  clientId: string;
  dietitianId?: string | null;
  weightKg?: number;
  heightCm?: number;
  waistCm?: number;
  hipsCm?: number;
  bodyFatPercent?: number;
  muscleMassKg?: number;
  goalWeightKg?: number;
  clientGoals?: string;
  notes?: string;
  recommendations?: string;
  followUpPlan?: string;
  bloodCollection?: boolean;
  bloodTests?: string[];
  nurseRequired?: boolean;
  visitDiscountType?: "percent" | "amount";
  visitDiscountValue?: number;
  visitDiscountReason?: string;
  visitDiscountCurrency?: Currency;
  // The dietitian removed the auto-added consultation-fee line from this visit.
  // The fee AMOUNT is never taken from the request — it's frozen server-side from
  // the dietitian's configured fee at creation.
  waiveConsultationFee?: boolean;
  treatments?: {
    machine: string;
    machineOther?: string;
    bodyParts?: string[];
    sessionsNeeded?: number;
    sessionsUsed?: number;
    clientPackageId?: string | null;
    applyPackageId?: string | null;
    sessionPlanId?: string | null;
    notes?: string;
  }[];
  products?: {
    // F4: only the catalog id + quantity come from the request; the server
    // snapshots name/price/currency from the Product catalog at save time.
    productId: string;
    quantity?: number;
    notes?: string;
  }[];
};

/** Keeps active↔completed in step with usage; preserves other statuses. */
function statusForUsage(current: string, used: number, total: number): string {
  if (used >= total) return "completed";
  if (current === "completed") return "active"; // reactivate when a reversal frees a session
  return current;
}

/**
 * Applies (`sign=+1`) or reverses (`sign=-1`) a consultation's usage effect on the
 * session plans and packages it draws from, reading the persisted rows as the
 * record of what has been applied. Editing a consultation reverses (−1) then
 * re-applies (+1), so usage is always the true total and never double-counts.
 * `sessionsUsed` (clinical) is what moves here; `sessionsPaid` is money-driven and
 * advances only at settlement.
 */
async function applyConsultationUsage(
  tx: Prisma.TransactionClient,
  consultationId: string,
  sign: 1 | -1,
): Promise<void> {
  const treatments = await tx.consultationTreatment.findMany({ where: { consultationId } });

  const planDelta = new Map<string, number>();
  const pkgDelta = new Map<string, number>();
  for (const t of treatments) {
    if (t.sessionPlanId && t.sessionsUsed > 0) {
      planDelta.set(t.sessionPlanId, (planDelta.get(t.sessionPlanId) ?? 0) + t.sessionsUsed);
    }
    if (t.clientPackageId && t.coveredSessions > 0) {
      pkgDelta.set(t.clientPackageId, (pkgDelta.get(t.clientPackageId) ?? 0) + t.coveredSessions);
    }
  }

  for (const [planId, amt] of planDelta) {
    const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
    if (!plan) continue;
    const newUsed = Math.max(0, plan.sessionsUsed + sign * amt);
    await tx.sessionPlan.update({
      where: { id: planId },
      data: { sessionsUsed: newUsed, status: statusForUsage(plan.status, newUsed, plan.sessionsNeeded) },
    });
  }
  for (const [pkgId, amt] of pkgDelta) {
    const cp = await tx.clientPackage.findUnique({ where: { id: pkgId } });
    if (!cp) continue;
    const newUsed = Math.max(0, Math.min(cp.totalSessions, cp.usedSessions + sign * amt));
    await tx.clientPackage.update({
      where: { id: pkgId },
      data: { usedSessions: newUsed, status: statusForUsage(cp.status, newUsed, cp.totalSessions) },
    });
  }
}

/**
 * Builds (or rebuilds) an existing consultation's billable content: coverage,
 * treatment/product/nutrition rows, the visit-service snapshot, the pending
 * delta basket (only what's newly added and not yet paid), the blood-sample
 * order, and finally applies the usage. The consultation row must already exist.
 * `allowBundles` is true only on first create — bundles are a one-time purchase.
 */
async function buildConsultationContentTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
  input: ConsultationInput,
  opts: {
    allowBundles: boolean;
    // Frozen product snapshots (by catalog id) from THIS consultation's prior save,
    // used to rebuild a sold line whose catalog product was deleted meanwhile — so
    // a historical sale is never dropped just because the catalog changed.
    priorProducts?: Map<string, { name: string; unitPrice: number; currency: Currency }>;
    // Acting user, threaded through so a blood-test removal/cancellation on this
    // save is attributed to whoever made it in the audit log (accountability).
    actor?: { name?: string | null; email?: string | null };
  },
): Promise<void> {
  const treatments = input.treatments ?? [];
  const inputProducts = input.products ?? [];
  const bmi = calcBmi(input.weightKg, input.heightCm) ?? null;

  // Consultation fee (USD): frozen onto the consultation at creation from the
  // visit dietitian's configured fee. This rebuild only READS it — it never
  // re-derives it from the live User.consultationFee — so a later admin change
  // can't re-price a saved visit (freeze-at-sale, same as treatment/product lines).
  // The dietitian may waive it for this specific visit.
  const consultRow = await tx.consultation.findUnique({
    where: { id: consultationId },
    select: { consultationFee: true, dietitian: { select: { fullName: true } } },
  });
  const consultationFee = consultRow?.consultationFee ?? 0;
  const consultationFeeWaived = input.waiveConsultationFee ?? false;
  const chargeConsultationFee = consultationFee > 0 && !consultationFeeWaived;

  const servicePrices = await tx.servicePrice.findMany({
    where: { active: true, kind: { in: ["blood_test", "treatment"] } },
  });
  // Blood tests are admin-managed in the catalog (like treatments); a name that
  // isn't a known catalog test is a custom entry priced under the "Other" bucket.
  const knownBloodTests = new Set<string>(
    servicePrices.filter((p) => p.kind === "blood_test").map((p) => p.key),
  );

  // F4: resolve each sold product against the admin-managed catalog and snapshot
  // its price/currency HERE — never trust a price from the request. A dietitian
  // who wants to charge less applies a logged visit discount instead.
  const productIds = [...new Set(inputProducts.map((p) => p.productId))];
  const catalogProducts = productIds.length
    ? await tx.product.findMany({ where: { id: { in: productIds } } })
    : [];
  const productById = new Map(catalogProducts.map((p) => [p.id, p]));
  const products = inputProducts.map((p) => {
    const quantity = Math.max(1, Math.floor(p.quantity ?? 1));
    // A line already sold on THIS consultation keeps its FROZEN sale-time snapshot
    // (name + unit price), always — never re-priced or renamed from the live
    // catalog, no matter what the admin later changed. `productId` identifies the
    // original catalog product but is never used to pull a current name/price into
    // a completed sale. This holds whether the catalog product was renamed,
    // re-priced, or deleted afterward. Quantity may still change on an open draft.
    const prior = opts.priorProducts?.get(p.productId);
    if (prior) {
      return {
        productId: p.productId,
        name: prior.name,
        quantity,
        unitPrice: prior.unitPrice,
        amount: prior.unitPrice * quantity,
        currency: prior.currency,
        notes: p.notes,
      };
    }
    // A brand-new line (first time this product is sold on this consultation) takes
    // its snapshot from the live catalog at this moment — the true time of sale.
    // Server-side snapshot, so a tampered request price is still ignored (F4).
    const cat = productById.get(p.productId);
    if (cat) {
      return {
        productId: p.productId,
        name: cat.name,
        quantity,
        unitPrice: cat.price,
        amount: cat.price * quantity,
        currency: asCurrency(cat.currency),
        notes: p.notes,
      };
    }
    throw new ConflictError("Product not found in catalog.");
  });

  // F10: every pre-existing package a treatment draws coverage from (or links to)
  // must belong to THIS visit's client — the same ownership check session plans
  // already enforce. Rejects an unknown id or another client's package outright.
  const referencedPackageIds = [
    ...new Set(treatments.map((t) => t.clientPackageId).filter((id): id is string => Boolean(id))),
  ];
  if (referencedPackageIds.length > 0) {
    const found = await tx.clientPackage.findMany({
      where: { id: { in: referencedPackageIds } },
      select: { id: true, clientId: true },
    });
    const ownedIds = new Set(found.filter((p) => p.clientId === input.clientId).map((p) => p.id));
    for (const id of referencedPackageIds) {
      if (!ownedIds.has(id)) {
        throw new ConflictError("This package does not belong to this client.");
      }
    }
  }

  // Start any bundles the dietitian applied (first save only): a paid,
  // machine-linked ClientPackage per bundle so its sessions are available now.
  const bundleByIndex = new Map<
    number,
    { clientPackageId: string; name: string; price: number; currency: Currency; sessions: number }
  >();
  if (opts.allowBundles) {
    for (let idx = 0; idx < treatments.length; idx++) {
      const t = treatments[idx];
      if (!t.applyPackageId) continue;
      const pkg = await tx.package.findUnique({ where: { id: t.applyPackageId } });
      if (!pkg || pkg.sessions <= 1) continue; // only real bundles (sessions > 1)
      const netPrice = Math.round(pkg.price * (1 - pkg.discountPercent / 100));
      const cp = await tx.clientPackage.create({
        data: {
          clientId: input.clientId,
          packageId: pkg.id,
          packageName: pkg.name,
          price: netPrice,
          cost: pkg.cost, // freeze the clinic cost at the sale (for correct historical profit)
          currency: pkg.currency,
          totalSessions: pkg.sessions,
          machine: t.machine,
          startDate: new Date(),
          status: "active",
        },
      });
      bundleByIndex.set(idx, {
        clientPackageId: cp.id,
        name: pkg.name,
        price: netPrice,
        currency: asCurrency(pkg.currency),
        sessions: pkg.sessions,
      });
    }
  }
  const effectivePackageId = (idx: number): string | null =>
    treatments[idx].clientPackageId ?? bundleByIndex.get(idx)?.clientPackageId ?? null;

  // Machine-package coverage: cap each treatment at its package's remaining balance,
  // allocated across treatments in order; excess is charged per session. Pre-seed
  // each referenced package's balance, then split through the shared allocator (the
  // same kernel the consultation editor previews with).
  const remainingBySource = new Map<string, number>();
  for (let idx = 0; idx < treatments.length; idx++) {
    const packageId = effectivePackageId(idx);
    if (packageId && !remainingBySource.has(packageId)) {
      const cp = await tx.clientPackage.findUnique({ where: { id: packageId } });
      remainingBySource.set(packageId, cp ? Math.max(0, cp.totalSessions - cp.usedSessions) : 0);
    }
  }
  const coverage = allocateCoverage(
    treatments.map((t, idx) => ({ sourceKey: effectivePackageId(idx), used: t.sessionsUsed ?? 0 })),
    remainingBySource,
  );

  // Sessions of THIS consultation already settled in an earlier installment must
  // NOT be re-counted as available credit when re-covering on edit — credit is
  // EXTERNAL (prior prepayments from other visits). Exclude this consultation's
  // own paid session lines so a paid installment can't phantom-cover a later edit.
  const consultPaidByPlan = new Map<string, number>();
  {
    const paidBaskets = await tx.visitBasket.findMany({
      where: { consultationId, status: "paid" },
      include: { items: true },
    });
    for (const b of paidBaskets) {
      for (const it of b.items) {
        if (it.sessionPlanId && !it.covered) {
          consultPaidByPlan.set(it.sessionPlanId, (consultPaidByPlan.get(it.sessionPlanId) ?? 0) + it.quantity);
        }
      }
    }
  }

  // Pay-as-you-go session plans (SEPARATE from packages): cover from prepaid credit.
  // Validate each referenced plan and seed its external credit, then split through
  // the shared allocator. Only a plan that belongs to THIS client and isn't
  // cancelled counts; anything else resolves to no source and is charged in full.
  const sessionPlanById = new Map<string, { unitPrice: number; currency: Currency }>();
  const sessionCreditLeft = new Map<string, number>();
  for (const t of treatments) {
    const planId = t.sessionPlanId ?? null;
    if (!planId || sessionPlanById.has(planId)) continue;
    const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
    if (plan && plan.clientId === input.clientId && plan.status !== "cancelled") {
      sessionPlanById.set(planId, { unitPrice: plan.unitPrice, currency: asCurrency(plan.currency) });
      // External credit only: exclude this consultation's own paid installments.
      const externalCredit = plan.sessionsPaid - (consultPaidByPlan.get(planId) ?? 0) - plan.sessionsUsed;
      sessionCreditLeft.set(planId, Math.max(0, externalCredit));
    }
  }
  const sessionCoverage = allocateCoverage(
    treatments.map((t) => ({
      sourceKey: t.sessionPlanId && sessionPlanById.has(t.sessionPlanId) ? t.sessionPlanId : null,
      used: t.sessionsUsed ?? 0,
    })),
    sessionCreditLeft,
  );
  const isSessionTreatment = (idx: number): boolean =>
    Boolean(treatments[idx].sessionPlanId) && sessionPlanById.has(treatments[idx].sessionPlanId!);
  const sessionPrice = (idx: number) => sessionPlanById.get(treatments[idx].sessionPlanId!)!;

  const bloodCharges = (input.bloodTests ?? []).map((name) =>
    priceSnapshot(servicePrices, "blood_test", knownBloodTests.has(name) ? name : "Other", name),
  );
  const serviceSubtotals: Record<string, number> = {};
  if (chargeConsultationFee) addMoney(serviceSubtotals, "USD", consultationFee);
  for (const charge of bloodCharges) addMoney(serviceSubtotals, charge.currency, charge.price);
  for (let idx = 0; idx < treatments.length; idx++) {
    const t = treatments[idx];
    if (isSessionTreatment(idx)) {
      const charged = sessionCoverage[idx].charged;
      if (charged <= 0) continue;
      const sp = sessionPrice(idx);
      addMoney(serviceSubtotals, sp.currency, sp.unitPrice * charged);
      continue;
    }
    const charged = coverage[idx].charged;
    if (charged <= 0) continue;
    const servicePrice = priceSnapshot(
      servicePrices,
      "treatment",
      t.machine === "Other" ? "Other" : t.machine,
      t.machineOther || t.machine,
    );
    addMoney(serviceSubtotals, servicePrice.currency, servicePrice.price * charged);
  }
  for (const b of bundleByIndex.values()) addMoney(serviceSubtotals, b.currency, b.price);
  for (const p of products) addMoney(serviceSubtotals, p.currency, p.amount);
  const serviceTotals = applyDiscount({
    subtotals: serviceSubtotals,
    discountType: input.visitDiscountType,
    discountValue: input.visitDiscountValue,
    discountCurrency: input.visitDiscountCurrency,
  });

  // Update the consultation's editable/clinical fields (not visitNumber/date).
  await tx.consultation.update({
    where: { id: consultationId },
    data: {
      dietitianId: input.dietitianId ?? null,
      weightKg: input.weightKg ?? null,
      heightCm: input.heightCm ?? null,
      bmi,
      waistCm: input.waistCm ?? null,
      hipsCm: input.hipsCm ?? null,
      bodyFatPercent: input.bodyFatPercent ?? null,
      muscleMassKg: input.muscleMassKg ?? null,
      goalWeightKg: input.goalWeightKg ?? null,
      clientGoals: input.clientGoals,
      notes: input.notes,
      recommendations: input.recommendations,
      followUpPlan: input.followUpPlan,
      bloodCollection: input.bloodCollection ?? false,
      bloodTests: input.bloodTests ? JSON.stringify(input.bloodTests) : null,
      bloodTestCharges: bloodCharges.length > 0 ? JSON.stringify(bloodCharges) : null,
      nurseRequired: input.nurseRequired ?? false,
      visitDiscountType: input.visitDiscountType,
      visitDiscountValue: input.visitDiscountValue ?? 0,
      visitDiscountReason: input.visitDiscountReason,
      visitDiscountCurrency: input.visitDiscountCurrency,
      visitServiceTotals: serviceTotals.length > 0 ? JSON.stringify(serviceTotals) : null,
      // Persist the waive decision so it survives the full rebuild on every save;
      // the frozen `consultationFee` amount is intentionally left untouched here.
      consultationFeeWaived,
    },
  });

  // Treatment rows — persist the covered split so package/plan usage reconciles.
  for (let idx = 0; idx < treatments.length; idx++) {
    const t = treatments[idx];
    const session = isSessionTreatment(idx);
    const sp = session
      ? sessionPrice(idx)
      : priceSnapshot(
          servicePrices,
          "treatment",
          t.machine === "Other" ? "Other" : t.machine,
          t.machineOther || t.machine,
        );
    const covered = session ? sessionCoverage[idx].covered : effectivePackageId(idx) ? coverage[idx].covered : 0;
    await tx.consultationTreatment.create({
      data: {
        consultationId,
        machine: t.machine,
        machineOther: t.machineOther,
        bodyParts: JSON.stringify(t.bodyParts ?? []),
        sessionsNeeded: t.sessionsNeeded ?? 1,
        sessionsUsed: t.sessionsUsed ?? 0,
        coveredSessions: covered,
        price: session ? (sp as { unitPrice: number }).unitPrice : (sp as { price: number }).price,
        currency: (sp as { currency: Currency }).currency,
        clientPackageId: session ? null : effectivePackageId(idx),
        sessionPlanId: session ? t.sessionPlanId : null,
        notes: t.notes,
      },
    });
  }
  for (const p of products) {
    await tx.consultationProduct.create({
      data: {
        consultationId,
        productId: p.productId, // permanent catalog reference (survives rename/delete)
        name: p.name,
        quantity: p.quantity,
        amount: p.amount,
        unitPrice: p.unitPrice, // frozen per-unit price (stored, not re-derived)
        currency: p.currency,
        notes: p.notes,
      },
    });
  }

  // Build the full billable set for this visit (covered lines tracked, not charged).
  // The consultation fee leads the basket (frozen USD amount from the visit
  // dietitian; omitted when waived or unset). It's a plain charge from here on —
  // settlement, installment netting, and debt-on-close treat it like any other.
  const basketItems: BasketItemInput[] = [
    ...(chargeConsultationFee
      ? [
          {
            kind: "consultation_fee",
            label: "Consultation fee",
            detail: consultRow?.dietitian?.fullName ?? undefined,
            quantity: 1,
            unitPrice: consultationFee,
            currency: "USD" as Currency,
            covered: false,
          },
        ]
      : []),
    ...bloodCharges.map((charge) => ({
      kind: "blood_test",
      label: charge.name,
      detail: "Blood test",
      quantity: 1,
      unitPrice: charge.price,
      currency: charge.currency,
      covered: false,
    })),
    ...treatments.flatMap((t, idx) => {
      if ((t.sessionsUsed ?? 0) <= 0) return [];
      const label = t.machine === "Other" ? t.machineOther || "Other treatment" : t.machine;
      const parts = (t.bodyParts ?? []).filter(Boolean);
      const partsLabel = parts.length > 0 ? parts.join(", ") : "General";
      const lines: BasketItemInput[] = [];
      if (isSessionTreatment(idx)) {
        const sp = sessionPrice(idx);
        const { covered, charged } = sessionCoverage[idx];
        if (covered > 0) {
          lines.push({
            kind: "treatment", label, detail: `${partsLabel} · ${covered} covered by credit`,
            quantity: covered, unitPrice: sp.unitPrice, currency: sp.currency, covered: true, sessionPlanId: t.sessionPlanId,
          });
        }
        if (charged > 0) {
          lines.push({
            kind: "treatment", label, detail: `${partsLabel} · ${charged} charged`,
            quantity: charged, unitPrice: sp.unitPrice, currency: sp.currency, covered: false, sessionPlanId: t.sessionPlanId,
          });
        }
        return lines;
      }
      const sp = priceSnapshot(
        servicePrices, "treatment", t.machine === "Other" ? "Other" : t.machine, t.machineOther || t.machine,
      );
      const { covered, charged } = coverage[idx];
      if (covered > 0) {
        lines.push({
          kind: "treatment", label, detail: `${partsLabel} · ${covered} covered by package`,
          quantity: covered, unitPrice: sp.price, currency: sp.currency, covered: true,
        });
      }
      if (charged > 0) {
        lines.push({
          kind: "treatment", label, detail: `${partsLabel} · ${charged} charged`,
          quantity: charged, unitPrice: sp.price, currency: sp.currency, covered: false,
        });
      }
      return lines;
    }),
    ...[...bundleByIndex.values()].map((b) => ({
      kind: "custom", label: b.name, detail: `Bundle · ${b.sessions} sessions`,
      quantity: 1, unitPrice: b.price, currency: b.currency, covered: false,
    })),
    ...products.map((p) => ({
      kind: "product", label: p.name, detail: "Product",
      quantity: p.quantity, unitPrice: p.unitPrice, currency: p.currency, covered: false,
    })),
  ];

  // Delta basket = what's newly added and not yet paid on THIS consultation.
  const hasCharge = basketItems.some((i) => !i.covered);
  if (hasCharge) {
    await upsertPendingBasketTx(tx, {
      clientId: input.clientId,
      dietitianId: input.dietitianId ?? null,
      consultationId,
      discountType: input.visitDiscountType ?? null,
      discountValue: input.visitDiscountValue ?? 0,
      discountReason: input.visitDiscountReason ?? null,
      currency: "USD",
      items: basketItems,
    });
  } else {
    // Nothing to charge: clear any stale pending delta. Record a $0 credit-covered
    // audit basket once (only if this consultation has no baskets yet).
    await tx.visitBasket.deleteMany({ where: { consultationId, status: "pending" } });
    const creditCoveredOnly = basketItems.some((i) => i.covered && i.sessionPlanId);
    const existingBaskets = await tx.visitBasket.count({ where: { consultationId } });
    if (creditCoveredOnly && existingBaskets === 0) {
      await createSettledBasketTx(tx, {
        clientId: input.clientId,
        dietitianId: input.dietitianId ?? null,
        consultationId,
        currency: "USD",
        items: basketItems,
      });
    }
  }

  // Reconcile the visit's lab order with the current draft: create it when tests
  // are first ordered, update its test list while it's still pending, and cancel
  // it (auditing the billed-then-cancelled removal) when the collection/tests are
  // taken off before anything reaches the lab. A sample already sent to the lab is
  // never silently rewritten — reconcileVisitBloodSampleTx refuses that save. (F#4)
  await reconcileVisitBloodSampleTx(
    tx,
    {
      clientId: input.clientId,
      dietitianId: input.dietitianId ?? null,
      consultationId,
      wantCollection: input.bloodCollection ?? false,
      tests: input.bloodTests ?? [],
    },
    opts.actor,
  );

  // Apply this consultation's usage from the rows just written.
  await applyConsultationUsage(tx, consultationId, 1);
}

async function getConsultationById(id: string): Promise<Consultation> {
  const row = await db.consultation.findUnique({ where: { id }, include });
  if (!row) throw new NotFoundError("Consultation not found");
  return toConsultation(row);
}

/**
 * On finalize (close), records the dietitian's visit discount in the audit log —
 * who applied it, the stated reason, and the amount. Called only at close, never
 * on a draft save, so re-saving a draft doesn't spam the log; a no-op when the
 * visit carries no discount. The USD money value is read from the frozen
 * visitServiceTotals snapshot (discounts are USD-only across the app).
 */
async function logVisitDiscountTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
  actor: { name?: string | null; email?: string | null },
): Promise<void> {
  const c = await tx.consultation.findUnique({
    where: { id: consultationId },
    select: {
      visitNumber: true,
      visitDiscountType: true,
      visitDiscountValue: true,
      visitDiscountReason: true,
      visitDiscountCurrency: true,
      visitServiceTotals: true,
    },
  });
  if (!c?.visitDiscountType || (c.visitDiscountValue ?? 0) <= 0) return;

  const money = parseServiceTotals(c.visitServiceTotals).reduce((s, t) => s + t.discount, 0);
  const configured =
    c.visitDiscountType === "percent"
      ? `${c.visitDiscountValue}%`
      : auditMoney(c.visitDiscountValue, c.visitDiscountCurrency);
  const amount = money > 0 ? `${configured} (${auditMoney(money, "USD")})` : configured;

  await writeAudit(tx, {
    userId: await userIdByEmail(actor.email ?? undefined),
    userName: actor.name,
    action: "Applied discount",
    entityType: "Consultation",
    entityLabel: `Visit #${c.visitNumber} — ${amount} off — ${c.visitDiscountReason ?? "no reason"}`,
  });
}

/**
 * On finalize (close), records a waived consultation fee in the audit log — which
 * patient, which dietitian, which visit, and that it dropped out of the basket.
 * Mirrors the visit-discount audit: written only at close (never on a draft save,
 * so re-saving doesn't spam the log), and a no-op when the fee wasn't waived or
 * the visit never carried one.
 */
async function logConsultationFeeWaiveTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
  actor: { name?: string | null; email?: string | null },
): Promise<void> {
  const c = await tx.consultation.findUnique({
    where: { id: consultationId },
    select: {
      visitNumber: true,
      consultationFee: true,
      consultationFeeWaived: true,
      client: { select: { firstName: true, lastName: true } },
      dietitian: { select: { fullName: true } },
    },
  });
  if (!c?.consultationFeeWaived || (c.consultationFee ?? 0) <= 0) return;

  const client = `${c.client.firstName} ${c.client.lastName}`;
  const dietitian = c.dietitian?.fullName ?? "Unassigned";
  await writeAudit(tx, {
    userId: await userIdByEmail(actor.email ?? undefined),
    userName: actor.name,
    action: "Consultation fee waived",
    entityType: "Consultation",
    entityLabel: `${client} (client) · ${dietitian} (doctor) waived the consultation fee — Visit #${c.visitNumber}, ${auditMoney(c.consultationFee ?? 0, "USD")} not charged`,
  });
}

/**
 * Guards the close: a visit can't be finalized while its basket is still waiting
 * for the secretary to settle it (a `pending` basket). Deletion (a mistaken
 * visit) is handled separately and is NOT blocked. Throws when a pending basket
 * exists so the caller surfaces "settle first" instead of silently closing.
 */
async function assertBasketSettledTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
): Promise<void> {
  const pending = await tx.visitBasket.count({
    where: { consultationId, status: "pending" },
  });
  if (pending > 0) {
    throw new ConflictError(
      "The secretary must settle this visit's basket before it can be closed.",
    );
  }
}

/**
 * Closing a visit finalizes it clinically, so the client's in-clinic appointment
 * is done: flip their live appointment to `completed` so it leaves the board for
 * everyone. The real signal is "the dietitian closed this visit," not which exact
 * queue button was pressed first — so we complete the appointment whether it was
 * sitting at `with_dietitian` OR still at `checked_in` (the secretary never clicked
 * "Send to dietitian", but the dietitian saw the client and closed the visit
 * anyway). Both are "physically present now" states, of which a client realistically
 * has exactly one, so matching by client + live status stays unambiguous even
 * though it isn't date-scoped.
 *
 * Deliberately NOT broadened to `scheduled`: that match isn't date-scoped, so
 * completing on `scheduled` would risk retiring a client's FUTURE booking when an
 * unrelated walk-in visit closes today. Terminal states (`completed`/`no_show`/
 * `cancelled`) are left alone — closing a visit shouldn't revive them.
 *
 * Matched by client + live status, not by date — a consultation is dated
 * `new Date()` while the appointment carries its scheduled day, so the two dates
 * need not coincide. A walk-in with no such appointment is a clean no-op. Runs in
 * the caller's transaction so the appointment and close commit together.
 */
async function completeLinkedAppointmentTx(
  tx: Prisma.TransactionClient,
  clientId: string,
): Promise<void> {
  await tx.appointment.updateMany({
    where: { clientId, status: { in: ["checked_in", "with_dietitian"] } },
    // Stamp when it finished so the queue's "Done" list can key on the close time
    // (today), not the appointment's originally-scheduled date.
    data: { status: "completed", completedAt: new Date() },
  });
}

/**
 * Retires this visit's already-settled baskets from the settlement queue when the
 * dietitian closes the visit. A `paid` basket lingers on the board only while its
 * visit is still open (so the secretary sees the just-settled client alongside the
 * still-in-clinic client); once the dietitian closes, the client moves to Done and
 * the paid basket has no further business on the board — flip it to `closed`. The
 * row is kept for audit, never charged again. Pending baskets can't reach close at
 * all — assertBasketSettledTx blocks a visit from closing until every basket is
 * settled.
 */
async function retirePaidBasketsTx(
  tx: Prisma.TransactionClient,
  consultationId: string,
): Promise<void> {
  await tx.visitBasket.updateMany({
    where: { consultationId, status: "paid" },
    data: { status: "closed" },
  });
}

/**
 * Creates a consultation as an editable draft (open). The dietitian can keep
 * editing it (updateConsultation) and settle it in installments, until they
 * close it. `close: true` finalizes it in the same action.
 */
export async function createConsultation(
  input: ConsultationInput,
  opts: { close?: boolean; actorName?: string | null; actorEmail?: string | null } = {},
): Promise<Consultation> {
  const priorVisits = await db.consultation.count({ where: { clientId: input.clientId } });
  const { id, closeBlocked } = await db.$transaction(async (tx) => {
    // One open visit per client. If this client already has an in-progress
    // consultation, don't create a duplicate (which would mint a second visit
    // number, frozen fee, and basket) — return the existing open visit instead,
    // so every path (the "Start consultation" button, a stale link, a
    // double-submit) continues the same draft rather than forking it. The UI
    // shows a notice when it lands on a visit it didn't create.
    const existingOpen = await tx.consultation.findFirst({
      where: { clientId: input.clientId, status: "open" },
      orderBy: { visitNumber: "desc" },
      select: { id: true },
    });
    if (existingOpen) return { id: existingOpen.id, closeBlocked: false };
    // Freeze the visit dietitian's configured consultation fee onto this visit at
    // creation. A snapshot (like treatment/product prices): if the admin later
    // changes the dietitian's fee, this visit keeps the amount that applied today.
    const dietitianId = input.dietitianId ?? null;
    const frozenFee = dietitianId
      ? (await tx.user.findUnique({
          where: { id: dietitianId },
          select: { consultationFee: true },
        }))?.consultationFee ?? null
      : null;
    const created = await tx.consultation.create({
      data: {
        clientId: input.clientId,
        dietitianId,
        date: new Date(),
        visitNumber: priorVisits + 1,
        status: "open",
        consultationFee: frozenFee,
        consultationFeeWaived: input.waiveConsultationFee ?? false,
      },
    });
    await buildConsultationContentTx(tx, created.id, input, {
      allowBundles: true,
      actor: { name: opts.actorName, email: opts.actorEmail },
    });
    if (opts.close) {
      // A visit with billable charges can't be closed on first save — its basket
      // must be settled by the secretary first. Persist the consultation (open,
      // basket sent) and signal the caller to reject the close, so a mistaken
      // "save & close" leaves a normal "sent for payment" state, not a lost visit.
      const pending = await tx.visitBasket.count({
        where: { consultationId: created.id, status: "pending" },
      });
      if (pending > 0) return { id: created.id, closeBlocked: true };
      // Nothing to settle (no billable delta): finalize now.
      await logVisitDiscountTx(tx, created.id, { name: opts.actorName, email: opts.actorEmail });
      await logConsultationFeeWaiveTx(tx, created.id, { name: opts.actorName, email: opts.actorEmail });
      await tx.consultation.update({
        where: { id: created.id },
        data: { status: "closed", closedAt: new Date() },
      });
      await completeLinkedAppointmentTx(tx, input.clientId);
      await retirePaidBasketsTx(tx, created.id);
    }
    return { id: created.id, closeBlocked: false };
  });
  if (closeBlocked) {
    throw new ConflictError(
      "The secretary must settle this visit's basket before it can be closed. The visit was saved and sent for payment.",
    );
  }
  return getConsultationById(id);
}

/**
 * Rebuilds an open consultation to a new full state: reverses this consultation's
 * prior usage, replaces its content, re-applies usage, and refreshes the pending
 * delta (only newly-added, unpaid items). Idempotent — re-saving the same state is
 * a no-op. Bundles are not startable on update (they're a one-time purchase).
 */
export async function updateConsultation(
  id: string,
  input: ConsultationInput,
  opts: { actorName?: string | null; actorEmail?: string | null } = {},
): Promise<Consultation> {
  await db.$transaction(async (tx) => {
    const existing = await tx.consultation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Consultation not found");
    if (existing.clientId !== input.clientId) {
      throw new ConflictError("Consultation does not belong to this client.");
    }
    if (existing.status === "closed") {
      throw new ConflictError("This visit is closed and can no longer be edited.");
    }
    await applyConsultationUsage(tx, id, -1); // reverse prior effect
    // Capture the frozen product snapshots (by catalog id) BEFORE clearing the
    // rows, so a sold line whose catalog product was deleted meanwhile can be
    // rebuilt from its own snapshot instead of vanishing on re-save.
    const priorProductRows = await tx.consultationProduct.findMany({ where: { consultationId: id } });
    const priorProducts = new Map<string, { name: string; unitPrice: number; currency: Currency }>();
    for (const r of priorProductRows) {
      if (r.productId) {
        priorProducts.set(r.productId, {
          name: r.name,
          // Read the frozen unit price straight from the column — never re-derive
          // it as amount ÷ quantity — so a later quantity change stays exact.
          unitPrice: r.unitPrice,
          currency: asCurrency(r.currency),
        });
      }
    }
    await tx.consultationTreatment.deleteMany({ where: { consultationId: id } });
    await tx.consultationProduct.deleteMany({ where: { consultationId: id } });
    await buildConsultationContentTx(tx, id, input, {
      allowBundles: false,
      priorProducts,
      actor: { name: opts.actorName, email: opts.actorEmail },
    });
  });
  return getConsultationById(id);
}

/**
 * Finalizes a visit — no further edits. The secretary must have settled the visit's
 * basket first (assertBasketSettledTx), so there's never an unpaid balance to
 * resolve here: anything the client didn't pay was already recorded as a tracked
 * ClientDebt at settlement, and session-plan shortfalls are tracked by the plan's
 * own `sessionsUsed > sessionsPaid` gap.
 */
export async function closeConsultation(
  id: string,
  opts: { actorName?: string | null; actorEmail?: string | null } = {},
): Promise<Consultation> {
  await db.$transaction(async (tx) => {
    const existing = await tx.consultation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Consultation not found");
    if (existing.status === "closed") throw new ConflictError("This visit is already closed.");

    // A visit can't be finalized while its basket is still awaiting settlement —
    // the secretary settles every basket (fully paid, or with the unpaid balance
    // recorded as a tracked debt) before close, so nothing unpaid reaches here.
    await assertBasketSettledTx(tx, id);
    await logVisitDiscountTx(tx, id, { name: opts.actorName, email: opts.actorEmail });
    await logConsultationFeeWaiveTx(tx, id, { name: opts.actorName, email: opts.actorEmail });
    await tx.consultation.update({ where: { id }, data: { status: "closed", closedAt: new Date() } });
    await completeLinkedAppointmentTx(tx, existing.clientId);
    await retirePaidBasketsTx(tx, id);
  });
  return getConsultationById(id);
}

/**
 * Deletes an open (not-yet-closed) consultation — the escape hatch for a visit
 * opened by mistake. Unlike closing, this is NOT blocked by an unsettled basket
 * (nothing has been collected yet). It refuses when money or obligations are
 * already recorded (a settled/debt-cleared basket, a tracked debt) or when the
 * visit draws on a package balance we can't safely unwind — those must be handled
 * by editing the visit or an admin. Reverses the visit's clinical usage first
 * (restoring session-plan credit), removes its pending basket + blood-sample
 * order, deletes the visit (treatments/products cascade), and cleans up any
 * empty session plan it alone created. Only the owning dietitian or an admin may
 * delete; the caller (route) already gates to clinical roles.
 */
export async function deleteConsultation(
  id: string,
  opts: {
    actorName?: string | null;
    actorEmail?: string | null;
    actorRole?: string | null;
  } = {},
): Promise<void> {
  await db.$transaction(async (tx) => {
    const existing = await tx.consultation.findUnique({
      where: { id },
      include: { treatments: true, client: { select: { firstName: true, lastName: true } } },
    });
    if (!existing) throw new NotFoundError("Consultation not found");
    if (existing.status === "closed") {
      throw new ConflictError("A closed visit is a permanent record and can't be deleted.");
    }

    // Ownership: a dietitian may delete only their own visit; an admin may delete
    // any. (The route restricts to clinical roles; this enforces the owner rule.)
    if (opts.actorRole === "dietitian") {
      const actorId = await userIdByEmail(opts.actorEmail ?? undefined);
      if (!actorId || existing.dietitianId !== actorId) {
        throw new ForbiddenError("You can only delete your own consultation.");
      }
    }

    // Money guard: never delete a visit that already collected money or recorded a
    // debt — that history must be preserved.
    const settled = await tx.visitBasket.count({
      where: { consultationId: id, status: "paid" },
    });
    if (settled > 0) {
      throw new ConflictError("This visit has settled payments and can't be deleted.");
    }
    const debts = await tx.clientDebt.count({ where: { consultationId: id } });
    if (debts > 0) {
      throw new ConflictError("This visit has recorded debt and can't be deleted.");
    }
    // Package-covered visits carry balances that can't be unwound cleanly on
    // delete — remove those treatments from the visit first (or use an admin edit).
    if (existing.treatments.some((t) => t.clientPackageId)) {
      throw new ConflictError("Remove this visit's package sessions before deleting it.");
    }

    // Reverse this visit's usage (restores session-plan credit it consumed).
    await applyConsultationUsage(tx, id, -1);

    const planIds = [
      ...new Set(existing.treatments.map((t) => t.sessionPlanId).filter((x): x is string => Boolean(x))),
    ];

    await tx.visitBasket.deleteMany({ where: { consultationId: id } });
    await tx.bloodSample.deleteMany({ where: { consultationId: id } });
    await tx.consultation.delete({ where: { id } }); // treatments/products cascade

    // Drop any session plan this visit alone created (now unreferenced, unpaid).
    for (const planId of planIds) {
      const stillReferenced = await tx.consultationTreatment.count({ where: { sessionPlanId: planId } });
      if (stillReferenced > 0) continue;
      const plan = await tx.sessionPlan.findUnique({ where: { id: planId } });
      if (plan && plan.sessionsPaid === 0) {
        await tx.sessionPlan.delete({ where: { id: planId } });
      }
    }

    await writeAudit(tx, {
      userId: await userIdByEmail(opts.actorEmail ?? undefined),
      userName: opts.actorName,
      action: "Deleted consultation",
      entityType: "Consultation",
      entityLabel: `Visit #${existing.visitNumber} — ${existing.client.firstName} ${existing.client.lastName} — deleted`,
    });
  });
}
