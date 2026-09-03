import { z } from "zod";
import { JESSY_METHOD, PAYMENT_METHOD_VALUES, VISIT_TYPE_VALUES } from "@/lib/types";
import { TENDER_CURRENCY_VALUES } from "@/lib/money";
import { FOOD_LIST_LANGUAGES } from "@/lib/food-list";
import { moneyCap } from "@/lib/utils";
import { todayIso, isWeekendIso, WEEKEND_BOOKING_MESSAGE, NONE_REFERRER, EXPENSE_BACKDATE_LIMIT_DAYS, earliestExpenseDate, latestExpenseDate } from "@/lib/config";
import { isValidInternationalPhone, PHONE_FORMAT_MESSAGE } from "@/lib/phone";

// ---- Patient phone format ----
// `PhoneInput` already blocks a malformed number in the UI, but the schema is
// the only gate a direct API call passes through — so the same rule is applied
// here, otherwise an unusable number reaches the database and every feature that
// dials it (WhatsApp, reminders) breaks on that patient. Requires an explicit
// country code: a bare national number can't be dialled internationally, and
// guessing its country risks contacting the wrong person.
const patientPhoneSchema = z
  .string()
  .min(1, "Phone is required")
  .refine(isValidInternationalPhone, PHONE_FORMAT_MESSAGE);

// ---- R5: money-input sanity bounds ----
// Reject negatives and unreasonably large amounts with a clear error instead of
// silently clamping them to $0 / accepting absurd typos. The currency-aware caps
// live in utils.ts so client forms and this server schema share one source.
/** Adds a validation error when `amount` exceeds the sane cap for its currency. */
export function refineMoneyCap(
  amount: number | undefined,
  currency: string | undefined,
  ctx: z.RefinementCtx,
  path: string,
) {
  if (amount === undefined) return;
  // Zod's `.min()/.positive()` accept Infinity (only NaN is rejected by the base
  // number type), so a crafted `1e400` reaches here as a finite-looking amount
  // that poisons every sum it lands in. Reject it explicitly before the cap check.
  if (!Number.isFinite(amount)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: "Amount must be a finite number.",
    });
    return;
  }
  if (amount > moneyCap(currency)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `Amount is unreasonably large (max ${moneyCap(currency).toLocaleString()} ${currency ?? "USD"}).`,
    });
  }
}

// ---- Tender legs (how money was physically handed over) ----
// Currency and payment method are INDEPENDENT dimensions: "Cash / EUR / €200" and
// "Cash / USD / $100" are two economically distinct legs of one settlement, not a
// duplicate. The USD value of a leg is never accepted from the client — the server
// resolves the admin-controlled rate itself and converts (see repositories).
export const tenderLegSchema = z
  .object({
    method: z.enum(PAYMENT_METHOD_VALUES),
    // Defaults to USD so every existing caller/payload keeps working unchanged.
    currency: z.enum(TENDER_CURRENCY_VALUES).default("USD"),
    amount: z.coerce.number().min(0),
  })
  .superRefine((v, ctx) => {
    refineMoneyCap(v.amount, v.currency, ctx, "amount");
    // Jessy's receivable ledger is USD-only by design (FIFO allocation across
    // receivables is only sound in a single unit). Enforced here AND in
    // createPayment — the UI hiding the option is not a control.
    if (v.method === JESSY_METHOD && v.currency !== "USD") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Jessy can only be recorded in USD — its receivable ledger is USD-only.",
      });
    }
  });

// ---- Date-of-birth sanity ----
// The native <input type="date"> lets users type absurd years (e.g. 20002),
// which produce an unparseable string that crashes Prisma with a 500. Accept
// only an empty string or a real calendar date within a sane year range, so a
// typo fails with a clear field error instead of an internal server error.
const dateOfBirthSchema = z
  .string()
  .optional()
  .refine(
    (v) => {
      if (!v) return true;
      const t = Date.parse(v);
      if (Number.isNaN(t)) return false;
      const year = new Date(t).getUTCFullYear();
      return year >= 1900 && year <= new Date().getUTCFullYear();
    },
    { message: "Enter a valid date of birth (year 1900–present)." },
  );

export const createClientSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: patientPhoneSchema,
  email: z.string().email().optional().or(z.literal("")),
  dateOfBirth: dateOfBirthSchema,
  gender: z.string().optional(),
  address: z.string().optional(),
  emergencyContact: z.string().optional(),
  medicalNotes: z.string().optional(),
  allergies: z.string().optional(),
  passportNumber: z.string().optional(),
  country: z.string().optional(),
  maritalStatus: z.string().optional(),
  // Required: who referred the patient (an external doctor, or "None"). Captured
  // at registration so the referrer is never silently dropped.
  referralSource: z.string().min(1, "Referrer is required"),
  firstTimePatient: z.boolean().optional(),
  intakeComplete: z.boolean().optional(),
  assignedDietitianId: z.string().nullish(),
  // Set once staff have seen the duplicate-phone warning and mean to register a
  // second patient on the same line anyway (e.g. a family member). Without it,
  // a matching phone returns a 409 carrying the existing patient(s) to warn on.
  confirmDuplicatePhone: z.boolean().optional(),
});

// Check-in / profile edits — every field optional so partial updates are allowed.
export const updateClientSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  // Optional (partial updates), but validated whenever it IS sent.
  phone: patientPhoneSchema.optional(),
  email: z.string().email().optional().or(z.literal("")),
  dateOfBirth: dateOfBirthSchema,
  gender: z.string().optional(),
  address: z.string().optional(),
  emergencyContact: z.string().optional(),
  medicalNotes: z.string().optional(),
  allergies: z.string().optional(),
  passportNumber: z.string().optional(),
  country: z.string().optional(),
  maritalStatus: z.string().optional(),
  referralSource: z.string().optional(),
  firstTimePatient: z.boolean().optional(),
  intakeComplete: z.boolean().optional(),
  assignedDietitianId: z.string().nullish(),
});

export const createPackageSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  // A package must grant at least one session (1 = single, >1 = bundle).
  sessions: z.coerce.number().int().min(1),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  status: z.string().optional(),
  // Every package is a bundle scoped to a treatment type (ServicePrice key).
  // There are no general/unscoped packages — this is required.
  machine: z.string().trim().min(1),
});

// Package edits — every field optional so the admin can change price, cost,
// details, or just the status. Reused by the PATCH route (status-only updates
// from the list toggle still validate here).
export const updatePackageSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  sessions: z.coerce.number().int().min(1).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const createAppointmentSchema = z.object({
  clientId: z.string().min(1),
  dietitianId: z.string().nullish(),
  // An appointment can't be booked into the past — today or later only.
  date: z
    .string()
    .min(1)
    .refine((d) => d >= todayIso(), {
      message: "Appointments can't be booked for a past date.",
    })
    // The clinic is closed on weekends — reject Sat/Sun even if the UI is bypassed.
    .refine((d) => !isWeekendIso(d), { message: WEEKEND_BOOKING_MESSAGE }),
  time: z.string().min(1),
  visitType: z.enum(VISIT_TYPE_VALUES),
  notes: z.string().optional(),
});

/**
 * Moving an existing booking to a new slot. Same when/who/what fields as
 * `createAppointmentSchema` (and the same past-date/weekend rules — a
 * reschedule can't land somewhere a fresh booking couldn't), minus `clientId`:
 * a reschedule never moves an appointment to a different patient.
 */
export const rescheduleAppointmentSchema = createAppointmentSchema
  .omit({ clientId: true, notes: true });

export const createConsultationSchema = z.object({
  clientId: z.string().min(1),
  dietitianId: z.string().nullish(),
  // The appointment this visit fulfils, carried from the queue. Closing the visit
  // completes this booking only — never every live appointment the patient has.
  // Server-checked against the patient; an id for someone else is refused.
  appointmentId: z.string().min(1).nullish(),
  // Finalize the visit in the same action (Close), vs. save it as an open draft.
  close: z.boolean().optional(),
  weightKg: z.coerce.number().positive().optional(),
  heightCm: z.coerce.number().positive().optional(),
  waistCm: z.coerce.number().positive().optional(),
  hipsCm: z.coerce.number().positive().optional(),
  bodyFatPercent: z.coerce.number().min(0).max(100).optional(),
  muscleMassKg: z.coerce.number().positive().optional(),
  goalWeightKg: z.coerce.number().positive().optional(),
  clientGoals: z.string().optional(),
  notes: z.string().optional(),
  recommendations: z.string().optional(),
  followUpPlan: z.string().optional(),
  // ---- Visit services ----
  bloodCollection: z.boolean().optional(),
  bloodTests: z.array(z.string()).optional(),
  nurseRequired: z.boolean().optional(),
  visitDiscountType: z.enum(["percent", "amount"]).optional(),
  visitDiscountValue: z.coerce.number().min(0).optional(),
  visitDiscountReason: z.string().trim().optional(),
  // Discounts are USD-only across the app; lock the server to match the UI so a
  // crafted request can't store an LBP discount currency.
  visitDiscountCurrency: z.literal("USD").optional(),
  // The dietitian removed the auto-added consultation-fee line from THIS visit's
  // basket. Persisted as Consultation.consultationFeeWaived; the admin's configured
  // per-dietitian fee is never touched. The fee AMOUNT is never accepted from the
  // request — the server freezes it from the dietitian's catalog fee at creation.
  waiveConsultationFee: z.boolean().optional(),
  treatments: z
    .array(
      z.object({
        machine: z.string().min(1),
        bodyParts: z.array(z.string()).optional(),
        sessionsNeeded: z.coerce.number().int().min(0).max(1000).optional(),
        sessionsUsed: z.coerce.number().int().min(0).max(1000).optional(),
        clientPackageId: z.string().nullish(),
        // Catalog bundle to start for the patient on this visit (charged once).
        applyPackageId: z.string().nullish(),
        // Pay-as-you-go session plan the sessions draw from (separate from
        // packages; a treatment uses one system or the other, never both).
        sessionPlanId: z.string().nullish(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  products: z
    .array(
      z.object({
        // F4: a sold product is identified by its catalog id only. The server
        // snapshots the name/price/currency from the admin-managed Product
        // catalog at save time — the request never carries a price.
        productId: z.string().min(1),
        quantity: z.coerce.number().int().min(1).max(100_000).optional(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  // Botox charges. Unlike treatments/products, each line carries an `id` when
  // it already exists on this consultation — the server needs it to tell an
  // edit of an existing line apart from a brand-new one, and to refuse a change
  // to a line that has already been paid (see ConsultationBotoxItem). Omitted
  // `id` = a new line. `chargedPrice` is the doctor's actual price for THIS
  // visit — it may be above or below the catalog's base price, with no
  // percentage bound; the base price itself is never accepted from the request,
  // only resolved server-side from the catalog.
  botoxItems: z
    .array(
      z
        .object({
          id: z.string().min(1).optional(),
          // Optional, not required: a PAID line's catalog item may since have
          // been hard-deleted (mirrors Product), which nulls this on the row —
          // resending that line (unchanged, as the paid-line lock requires)
          // must still validate. Only actually resolving/creating a NEW or
          // still-unpaid line requires it, enforced in buildBotoxLinesTx, which
          // is the one place that also knows whether a line is locked.
          botoxItemId: z.string().min(1).optional(),
          quantity: z.coerce.number().int().min(1).max(1000).optional(),
          chargedPrice: z.coerce.number().positive("Price must be greater than 0"),
          notes: z.string().optional(),
        })
        .superRefine((v, ctx) => refineMoneyCap(v.chargedPrice, "USD", ctx, "chargedPrice")),
    )
    .max(100)
    .optional(),
  // ---- External Lab Blood Collection ----
  // Tests outsourced to a third-party lab that bills the clinic ONE lump sum for
  // the whole group, so the money is on the ORDER and the test lines carry none.
  //
  // Three meanings, and they are all load-bearing:
  //   omitted  — the card was never opened; leave any stored order alone (and
  //              keep billing it — see buildConsultationContentTx).
  //   object   — this is the order now.
  //   null     — the doctor removed the order from the visit.
  // `.nullish()` rather than `.optional()` is what makes `null` reach the
  // repository as a real instruction instead of being dropped.
  //
  // `totalCostPrice` is optional HERE because a caller who may not set it simply
  // doesn't send it; whether it is honoured is a permission decision made
  // server-side in buildExternalLabOrderTx, never inferred from its presence.
  externalLabOrder: z
    .object({
      totalCostPrice: z.coerce.number().min(0, "Cost can't be negative").optional(),
      totalSalePrice: z.coerce.number().min(0, "Sale price can't be negative"),
      // Required by the server (and by a CHECK constraint) only when the sale
      // price is below the cost — a comparison this schema can't make reliably,
      // since the cost may legitimately be absent from the payload.
      belowCostReason: z.string().trim().max(500).optional(),
      notes: z.string().trim().max(2000).optional(),
      tests: z
        .array(
          z.object({
            name: z.string().trim().min(1, "Test name is required").max(200),
            description: z.string().trim().max(2000).optional(),
          }),
        )
        .min(1, "List at least one test")
        .max(50),
    })
    .superRefine((v, ctx) => {
      refineMoneyCap(v.totalSalePrice, "USD", ctx, "totalSalePrice");
      if (v.totalCostPrice !== undefined) {
        refineMoneyCap(v.totalCostPrice, "USD", ctx, "totalCostPrice");
      }
    })
    .nullish(),
  // ---- Food List (Nutrient-Rich Foods List) ----
  // Absent = the doctor never opened the card; the stored form (if any) is left
  // untouched. Present = save it. `selections` is filtered against the catalog in
  // the repository, so an unknown id is dropped rather than rejecting the whole
  // visit — a partially-stale payload must never cost the doctor their notes.
  foodList: z
    .object({
      language: z.enum(FOOD_LIST_LANGUAGES).optional(),
      patientName: z.string().trim().max(200),
      notes: z.string().trim().max(4000).optional(),
      selections: z.array(z.string()).max(500).optional(),
    })
    .optional(),
}).superRefine((v, ctx) => {
  // A reason is mandatory whenever a discount is actually applied.
  if (v.visitDiscountType && (v.visitDiscountValue ?? 0) > 0 && !v.visitDiscountReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visitDiscountReason"],
      message: "A reason is required when a discount is applied.",
    });
  }
});

export const createPaymentSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    motif: z.string().trim().min(1),
    // Reject negative and $0 amounts (a $0 receipt is meaningless), and cap the
    // upper end per currency (R5) rather than silently clamping.
    amountPaid: z.coerce.number().positive("Amount must be greater than 0"),
    // A payment is TENDER, so it may be USD, EUR or LBP — unlike a price or a
    // debt, which stay USD/LBP obligations. No rate is accepted here: the server
    // resolves and freezes it (a client-supplied rate is an unaudited discount).
    currency: z.enum(TENDER_CURRENCY_VALUES).optional(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    notes: z.string().optional(),
    // Optional client-generated key so a double-submit can't create a duplicate
    // payment (R2). Absent for programmatic callers.
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    refineMoneyCap(v.amountPaid, v.currency, ctx, "amountPaid");
    if (v.method === JESSY_METHOD && (v.currency ?? "USD") !== "USD") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Jessy can only be recorded in USD — its receivable ledger is USD-only.",
      });
    }
  });

// ---- Visit basket (dietitian → secretary settlement) ----
const visitBasketItemSchema = z
  .object({
    kind: z
      .enum([
        "blood_test",
        "treatment",
        "product",
        "package",
        "custom",
        "consultation_fee",
        "botox",
        "external_lab",
      ])
      .optional(),
    label: z.string().trim().min(1),
    detail: z.string().optional(),
    // Cap quantity so an absurd count can't produce an absurd total (R5).
    quantity: z.coerce.number().int().min(1).max(100_000).optional(),
    unitPrice: z.coerce.number().min(0).optional(),
    currency: z.enum(["USD", "LBP"]).optional(),
    covered: z.boolean().optional(),
    // Preserved through send/edit so a session line keeps its plan link (settlement
    // advances that plan's sessionsPaid by the final settled quantity).
    sessionPlanId: z.string().nullish(),
    // Preserved through send/edit so a "product" line keeps its catalog link —
    // settlement deducts inventory by the final settled quantity per product.
    productId: z.string().nullish(),
    // Preserved through send/edit so a bundle line keeps its package link. Without
    // it the round-trip through the settlement screen would strip the link and the
    // server's package guard would see the line as removed.
    clientPackageId: z.string().nullish(),
    // Preserved through send/edit so a "botox" line keeps its
    // ConsultationBotoxItem link — this is what updateVisitBasket's price-lock
    // keys on, and what would otherwise let a botox line be re-priced at
    // checkout like an anonymous "custom" one.
    consultationBotoxItemId: z.string().nullish(),
    // Preserved through send/edit so an external-lab line keeps its link to the
    // order that priced it — that link is what price-protects it at checkout.
    externalLabOrderId: z.string().nullish(),
    // NOTE: `unitCost` is deliberately absent. The clinic's cost is never accepted
    // from a request — it is snapshotted server-side from the catalog at the same
    // moment as the price, exactly like `unitPrice` is re-derived rather than
    // trusted. A client-supplied cost would be an unaudited margin channel.
  })
  .superRefine((v, ctx) => refineMoneyCap(v.unitPrice, v.currency, ctx, "unitPrice"));

// A reason is mandatory whenever a discount is actually applied to a basket.
function requireDiscountReason(
  v: { discountType?: string | null; discountValue?: number; discountReason?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.discountType && (v.discountValue ?? 0) > 0 && !v.discountReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountReason"],
      message: "A reason is required when a discount is applied.",
    });
  }
}

// Secretary edits the basket (add/remove items, adjust discount) before settling.
export const updateVisitBasketSchema = z
  .object({
    discountType: z.enum(["percent", "amount"]).nullish(),
    discountValue: z.coerce.number().min(0).optional(),
    discountReason: z.string().trim().nullish(),
    currency: z.enum(["USD", "LBP"]).optional(),
    items: z.array(visitBasketItemSchema),
  })
  .superRefine(requireDiscountReason)
  .superRefine((v, ctx) => {
    // Cap a fixed-amount discount per currency (a percent is already bounded to
    // 0–100% by the shared discount rule). R5.
    if (v.discountType === "amount") refineMoneyCap(v.discountValue, v.currency, ctx, "discountValue");
  });

// Secretary settles the basket — records the payment and marks it paid. The
// optional debt fields let the secretary record a still-owed remainder (override)
// as a tracked ClientDebt at the same time.
export const settleVisitBasketSchema = z
  .object({
    // How the collected money was tendered: one entry per method × currency. A
    // single-method USD settlement is one entry (unchanged). Amounts are NATIVE to
    // each entry's currency; the server converts every entry to USD at the rate it
    // resolves itself and enforces that the total matches what is being collected
    // (settleVisitBasket — it needs the basket total).
    splits: z.array(tenderLegSchema).default([]),
    // The FX rates the settlement screen was DISPLAYING when the desk prepared
    // this payment, as {currency: rate}. Advisory only, and never used to value
    // anything: the server resolves its own rates and compares, so that a rate
    // changed mid-checkout is rejected with a specific "the rate changed" error
    // instead of a bare arithmetic mismatch. A forged value cannot move a single
    // figure — at worst it refuses its own settlement.
    expectedRates: z
      .object({
        EUR: z.coerce.number().finite().gt(0).optional(),
        LBP: z.coerce.number().finite().gt(0).optional(),
      })
      .optional(),
    notes: z.string().optional(),
    debtAmount: z.coerce.number().min(0).optional(),
    debtReason: z.string().trim().optional(),
    // Existing outstanding debt ids to collect alongside today's charges (the
    // auto-suggested debt line). Each is cleared in full via the hardened path.
    clearDebtIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.debtAmount ?? 0) > 0 && !v.debtReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["debtReason"],
        message: "A reason is required when recording a debt.",
      });
    }
    // Cap the owed-remainder amount. A deferred remainder is an OBLIGATION, so it
    // is always USD — never the tender currency. R5.
    refineMoneyCap(v.debtAmount, "USD", ctx, "debtAmount");
    // Per-leg caps/currency rules live in tenderLegSchema (each leg is capped in
    // its OWN currency — an LBP leg legitimately runs to eight digits).
  });

// Secretary clears (collects — records a payment) or voids (writes off) a debt.
export const updateClientDebtSchema = z
  .object({
    action: z.enum(["clear", "void"]),
    method: z.enum(PAYMENT_METHOD_VALUES).optional(),
    // How the money was handed over. Omitted => the legacy shorthand "one USD leg
    // for the debt's full outstanding balance", which is what `method` alone has
    // always meant. Supplied => the debt is reduced by the USD equivalent of these
    // legs, which may be a PARTIAL payment. The debt itself stays USD either way.
    tender: z.array(tenderLegSchema).optional(),
    notes: z.string().optional(),
    // Why the debt is being written off — required for a void so the forgiveness
    // is never unexplained. Ignored for a clear (that records a real payment).
    reason: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "clear" && !v.method && !(v.tender && v.tender.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "A payment method is required to clear a debt.",
      });
    }
    if (v.action === "clear" && v.tender && v.tender.length > 0) {
      const positive = v.tender.filter((t) => t.amount > 0);
      if (positive.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tender"],
          message: "Enter an amount to collect.",
        });
      }
    }
    if (v.action === "void" && !v.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required to void a debt.",
      });
    }
  });

// ---- Jessy settlements (money received FROM the third-party payer) ----
// This records a COLLECTION of an existing receivable, never new income — the
// income was already recognized when the patient paid through Jessy. The amount
// is USD (the receivable ledger's currency) and is checked against the live
// outstanding balance server-side, where over-settlement is refused.
export const recordJessySettlementSchema = z
  .object({
    amount: z.coerce.number().positive("Amount must be greater than 0"),
    reference: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional(),
    // Optional client-generated key so a double-submit can't record the same
    // transfer twice (mirrors createPaymentSchema).
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => refineMoneyCap(v.amount, "USD", ctx, "amount")); // R5 cap

// ---- Blood sample tracking ----
// The secretary advances a sample through send → receive (or undoes either).
// `at` lets them correct the recorded time; omitted, the server stamps "now".
// `notes` carries an optional courier/lab reference. At least one of the two
// must be present so an empty PATCH is rejected.
export const updateBloodSampleSchema = z
  .object({
    action: z.enum(["send", "receive", "unsend", "unreceive"]).optional(),
    at: z.string().datetime().optional(),
    notes: z.string().trim().max(200).nullish(),
  })
  .refine((v) => v.action !== undefined || v.notes !== undefined, {
    message: "Nothing to update",
  });

export const updateSettingsSchema = z
  .object({
    // `.positive()` alone accepts Infinity in zod (only NaN is rejected by the
    // base number type). An infinite rate would silently value every LBP/EUR
    // payment at $0, so both bounds are explicit. The ranges are "this is a
    // misconfiguration" bounds, far wider than any real move.
    usdToLbp: z.coerce.number().finite().gt(0).max(100_000_000).optional(),
    usdToEur: z.coerce.number().finite().gt(0).max(100).optional(),
    // 0 is valid and intentional — it disables the card surcharge entirely.
    cardSurchargePercent: z.coerce.number().min(0).max(100).optional(),
    // Explicit acknowledgement of a suspicious rate jump, as {rateKey: value}.
    // NOT a bypass flag: the server re-detects the suspicion from values it reads
    // itself and only honours an acknowledgement whose VALUE matches the one being
    // saved, so this can never wave a different number through.
    confirmSuspicious: z
      .object({
        usdToLbp: z.coerce.number().finite().gt(0).optional(),
        usdToEur: z.coerce.number().finite().gt(0).optional(),
      })
      .optional(),
  })
  .refine(
    (v) =>
      v.usdToLbp !== undefined || v.usdToEur !== undefined || v.cardSurchargePercent !== undefined,
    { message: "At least one setting must be provided" },
  );

// Botox catalog (admin only). USD-only by design, like the consultation fee and
// Jessy — a premium/doctor-set service price, not a stock-tracked line, so it
// skips Product's stock/lowStockThreshold fields.
export const createBotoxItemSchema = z
  .object({
    name: z.string().trim().min(1),
    price: z.coerce.number().min(0),
    cost: z.coerce.number().min(0).optional(),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => refineMoneyCap(v.price, "USD", ctx, "price"));

export const updateBotoxItemSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    price: z.coerce.number().min(0).optional(),
    cost: z.coerce.number().min(0).optional(),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => refineMoneyCap(v.price, "USD", ctx, "price"));

export const createProductSchema = z.object({
  name: z.string().trim().min(1),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  active: z.boolean().optional(),
  // Initial on-hand count — a plain field like price/cost since nothing existed
  // before to diff against. Every change AFTER creation must go through
  // adjustProductStockSchema instead, so it's always an audited delta.
  stock: z.coerce.number().int().min(0).optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
});

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).optional(),
  price: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  active: z.boolean().optional(),
  // Reorder point only — NOT stock itself, which is adjustment-only (see above).
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
});

// Admin-only inventory adjustment: a signed delta (never a raw overwrite) so
// AuditLog stays the full history of every stock change. "sale" is applied
// automatically by the consultation save path (see consultations.ts); this
// schema is for the two manual kinds an admin triggers from the Pricing page.
export const adjustProductStockSchema = z.object({
  delta: z.coerce
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, "Amount can't be zero"),
  type: z.enum(["restock", "correction"]),
  reason: z.string().trim().max(500).optional(),
});

// "None" is a reserved, built-in dropdown choice meaning "came organically" — it's
// always offered automatically, so an admin can't add a list entry with that name
// (a duplicate that would also imply a fee could be attached to organic patients).
const reservedReferrerName = (name: string | undefined, ctx: z.RefinementCtx) => {
  if (name && name.trim().toLowerCase() === NONE_REFERRER.toLowerCase()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: `"${NONE_REFERRER}" is a built-in option (came organically) — pick a different name.`,
    });
  }
};

export const createReferrerSchema = z
  .object({
    name: z.string().trim().min(1),
    active: z.boolean().optional(),
    // Per-referral commission in USD. 0 = no fee. Capped like any money input.
    fee: z.coerce.number().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    refineMoneyCap(v.fee, "USD", ctx, "fee");
    reservedReferrerName(v.name, ctx);
  });

export const updateReferrerSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    active: z.boolean().optional(),
    fee: z.coerce.number().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    refineMoneyCap(v.fee, "USD", ctx, "fee");
    reservedReferrerName(v.name, ctx);
  });

export const updateServicePriceSchema = z.object({
  price: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  active: z.boolean().optional(),
});

// Admin creates new catalog entries: treatment types (machines) with their own
// body-part presets, or blood tests (no body parts). Defaults to treatment.
// bodyParts: null → free-text entry, [] → no body-part field, [names] → checklist.
export const createServicePriceSchema = z.object({
  kind: z.enum(["blood_test", "treatment"]).optional(),
  name: z.string().trim().min(1),
  price: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  bodyParts: z.array(z.string().trim().min(1)).nullable().optional(),
});

export const recordReferralPayoutSchema = z.object({
  // Which commissions this transfer settles. The server re-reads each one and
  // refuses any that is already paid or voided, so the list is a request, not a
  // fact — a stale screen can never mark the same commission paid twice.
  commissionIds: z.array(z.string().trim().min(1)).min(1).max(500),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
  // Replay guard for a double-clicked confirm.
  idempotencyKey: z.string().trim().max(200).nullish(),
  // NOTE: no amount. The payout is worth exactly the sum of the commissions it
  // settles, computed server-side from their FROZEN amounts. Accepting a figure
  // from the client would let a payout disagree with what it claims to pay.
});

export const voidReferralCommissionSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to void a commission."),
});

export const createExpenseSchema = z
  .object({
    title: z.string().min(1),
    amount: z.coerce.number().positive(),
    currency: z.enum(["USD", "LBP"]).optional(),
    date: z.string().min(1),
    method: z.string().min(1),
    notes: z.string().min(1),
    paidBy: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    refineMoneyCap(v.amount, v.currency, ctx, "amount"); // R5 cap
    // The date decides which reporting period the expense lands in, and it is
    // immutable once saved. A far back-dated entry would silently rewrite a
    // period that has already been reported; a future-dated one would file the
    // expense into a period that hasn't happened yet. Allowed window:
    // [today − 30 days, today], in CLINIC days. createExpense enforces the same
    // bounds on the write path; these are here so the route answers 400 with a
    // field-level message instead of a generic conflict.
    const earliest = earliestExpenseDate();
    const latest = latestExpenseDate();
    if (v.date < earliest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["date"],
        message: `An expense can't be dated before ${earliest} (${EXPENSE_BACKDATE_LIMIT_DAYS} days back).`,
      });
    }
    if (v.date > latest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["date"],
        message: `An expense can't be dated in the future (nothing after ${latest}).`,
      });
    }
  });

// Expense edits reuse the same field rules but the DATE is immutable after
// creation (F8) — it's omitted here so a client can't change which reporting
// period an expense counts toward.
export const updateExpenseSchema = z
  .object({
    title: z.string().min(1),
    amount: z.coerce.number().positive(),
    currency: z.enum(["USD", "LBP"]).optional(),
    method: z.string().min(1),
    notes: z.string().min(1),
    paidBy: z.string().optional(),
  })
  .superRefine((v, ctx) => refineMoneyCap(v.amount, v.currency, ctx, "amount"));

// Medical history — full upsert payload (the form always sends every field).
const yesNo = z.boolean().nullish();
const text = z.string().nullish();
export const medicalHistorySchema = z.object({
  conditions: z.array(z.string()).optional(),
  intoleranceDetail: text,
  conditionsOther: text,
  medicalHistoryNote: text,

  hasAllergies: yesNo,
  allergiesDetail: text,

  takingMedications: yesNo,
  medicationsDetail: text,
  takingSupplements: yesNo,
  supplementsDetail: text,
  hadSurgeries: yesNo,
  surgeriesDetail: text,

  familyHistory: z.array(z.string()).optional(),
  familyCancerDetail: text,
  familyOther: text,
  familyHistoryNote: text,

  drinksWater: yesNo,
  waterGlasses: text,
  drinksCaffeine: yesNo,
  drinksAlcohol: yesNo,
  alcoholFrequency: text,
  smokes: yesNo,
  cigarettesPerDay: text,
  exercises: yesNo,
  exerciseType: text,
  exerciseFrequency: text,
  sleepHours: text,
  wakesRested: yesNo,
  feelsStressed: yesNo,
  followsDiet: yesNo,
  snacksFrequently: yesNo,
  feelsFatigued: yesNo,
  moodSwings: yesNo,

  lifestyleNotes: z.record(z.string(), z.string()).optional(),
});

// A pay-as-you-go session plan (per-session client, separate from Packages).
// F4: the per-session price/currency are NOT accepted from the request — the
// server snapshots them from the admin-managed ServicePrice catalog for the
// treatment, so a dietitian can't set an off-catalog price. `machine` is required
// because it is the catalog key the price is drawn from.
export const createSessionPlanSchema = z.object({
  clientId: z.string().min(1),
  machine: z.string().trim().min(1),
  sessionsNeeded: z.coerce.number().int().min(1).max(1000),
});

// A standalone session sale (front desk, no consultation). Same rule as above:
// the price is never accepted from the request, only the treatment and how many.
export const sellSessionsSchema = z.object({
  clientId: z.string().min(1),
  machine: z.string().trim().min(1),
  sessions: z.coerce.number().int().min(1).max(1000),
});

// A machine visit records consumption only: which prepaid source, how many
// sessions, an optional note. No price, no balance and no paid status is accepted
// from the client — the server reads all three from the plan/bundle rows.
export const createMachineVisitSchema = z.object({
  clientId: z.string().min(1),
  items: z
    .array(
      z
        .object({
          sessionPlanId: z.string().min(1).nullish(),
          clientPackageId: z.string().min(1).nullish(),
          sessions: z.coerce.number().int().min(1).max(100),
        })
        .refine(
          (i) => Boolean(i.sessionPlanId) !== Boolean(i.clientPackageId),
          "Each line must draw on exactly one treatment.",
        ),
    )
    .min(1)
    .max(20),
  note: z.string().trim().max(500).optional(),
  appointmentId: z.string().min(1).nullish(),
  // Replay guard for a double-clicked Confirm or a retried request.
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export const voidMachineVisitSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const verifyTwoFactorSchema = z.object({
  pendingToken: z.string().min(1),
  // Either a 6-digit TOTP code or an XXXXX-XXXXX backup code.
  code: z.string().min(1),
});

export const confirmTwoFactorSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1),
});

export const resetStaffPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const createStaffSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  role: z.enum(["secretary", "dietitian", "admin"]),
  status: z.string().optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// Edit an existing staff member's details. Every field is optional so callers
// can send only what changed (the status-only toggle still goes through here).
// Password is deliberately absent — it has its own admin-reset flow (which also
// revokes sessions). At least one field must be present so an empty PATCH is a
// no-op error rather than a silent success.
export const updateStaffSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    role: z.enum(["secretary", "dietitian", "admin"]).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    // Admin-only per-doctor Botox access toggle. Meaningful for a dietitian
    // only; harmless (ignored server-side by canOfferBotox) on any other role.
    canOfferBotox: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "No changes provided",
  });

// A dietitian's personal recommended-supplement options. Trimmed, de-duplicated
// and capped so the list stays sane; free-text so custom supplements are allowed.
export const updateStaffSupplementsSchema = z.object({
  supplements: z
    .array(z.string().trim().min(1).max(60))
    .max(60),
});

// Admin sets a dietitian's consultation fee (USD). 0 clears it (no fee applied).
// Capped like every other money input (R5) so an absurd typo is rejected.
export const updateStaffConsultationFeeSchema = z
  .object({ consultationFee: z.coerce.number().min(0) })
  .superRefine((v, ctx) => refineMoneyCap(v.consultationFee, "USD", ctx, "consultationFee"));

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export type CreateConsultationInput = z.infer<typeof createConsultationSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdateVisitBasketInput = z.infer<typeof updateVisitBasketSchema>;
export type SettleVisitBasketInput = z.infer<typeof settleVisitBasketSchema>;
export type UpdateBloodSampleInput = z.infer<typeof updateBloodSampleSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type RecordReferralPayoutInput = z.infer<typeof recordReferralPayoutSchema>;
export type VoidReferralCommissionInput = z.infer<typeof voidReferralCommissionSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type CreateSessionPlanInput = z.infer<typeof createSessionPlanSchema>;
export type SellSessionsInput = z.infer<typeof sellSessionsSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type UpdateStaffSupplementsInput = z.infer<typeof updateStaffSupplementsSchema>;
export type UpdateStaffConsultationFeeInput = z.infer<typeof updateStaffConsultationFeeSchema>;
export type CreateBotoxItemInput = z.infer<typeof createBotoxItemSchema>;
export type UpdateBotoxItemInput = z.infer<typeof updateBotoxItemSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AdjustProductStockInput = z.infer<typeof adjustProductStockSchema>;
export type CreateReferrerInput = z.infer<typeof createReferrerSchema>;
export type UpdateReferrerInput = z.infer<typeof updateReferrerSchema>;
export type UpdateServicePriceInput = z.infer<typeof updateServicePriceSchema>;
export type CreateServicePriceInput = z.infer<typeof createServicePriceSchema>;
export type UpdateClientDebtInput = z.infer<typeof updateClientDebtSchema>;
export type RecordJessySettlementInput = z.infer<typeof recordJessySettlementSchema>;
export type MedicalHistoryInput = z.infer<typeof medicalHistorySchema>;
export type CreateMachineVisitInput = z.infer<typeof createMachineVisitSchema>;
export type VoidMachineVisitInput = z.infer<typeof voidMachineVisitSchema>;

/**
 * The front desk's edit of an external-lab order: the SALE PRICE, and nothing
 * else. Deliberately its own schema rather than a partial of the order schema —
 * the shape is the permission. There is no field here for the cost, the notes or
 * the test list, so no combination of request keys can reach them through this
 * route however it is crafted.
 */
export const externalLabSalePriceSchema = z.object({
  totalSalePrice: z.coerce
    .number()
    .min(0, "Sale price can't be negative")
    .superRefine((v, ctx) => refineMoneyCap(v, "USD", ctx, "totalSalePrice")),
  // Required by the server only when the new price falls below the order's cost.
  // The requester may not be allowed to KNOW that it does — see
  // setExternalLabSalePrice, which refuses without naming the cost.
  belowCostReason: z.string().trim().max(500).optional(),
});
