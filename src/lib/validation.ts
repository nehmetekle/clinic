import { z } from "zod";
import { PAYMENT_METHOD_VALUES, VISIT_TYPE_VALUES } from "@/lib/types";
import { moneyCap } from "@/lib/utils";
import { todayIso, isWeekendIso, WEEKEND_BOOKING_MESSAGE } from "@/lib/config";

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
  if (amount !== undefined && amount > moneyCap(currency)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `Amount is unreasonably large (max ${moneyCap(currency).toLocaleString()} ${currency ?? "USD"}).`,
    });
  }
}

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
  phone: z.string().min(1, "Phone is required"),
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
  phone: z.string().min(1).optional(),
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

export const createConsultationSchema = z.object({
  clientId: z.string().min(1),
  dietitianId: z.string().nullish(),
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
        machineOther: z.string().optional(),
        bodyParts: z.array(z.string()).optional(),
        sessionsNeeded: z.coerce.number().int().min(0).optional(),
        sessionsUsed: z.coerce.number().int().min(0).optional(),
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
    currency: z.enum(["USD", "LBP"]).optional(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    notes: z.string().optional(),
    // Optional client-generated key so a double-submit can't create a duplicate
    // payment (R2). Absent for programmatic callers.
    idempotencyKey: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => refineMoneyCap(v.amountPaid, v.currency, ctx, "amountPaid"));

// ---- Visit basket (dietitian → secretary settlement) ----
const visitBasketItemSchema = z
  .object({
    kind: z.enum(["blood_test", "treatment", "product", "custom", "consultation_fee"]).optional(),
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
    method: z.enum(PAYMENT_METHOD_VALUES),
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
    // Cap the owed-remainder amount (entered in the basket's currency, USD by
    // default across the app) so an absurd typo is rejected, not accepted. R5.
    refineMoneyCap(v.debtAmount, "USD", ctx, "debtAmount");
  });

// Secretary clears (collects — records a payment) or voids (writes off) a debt.
export const updateClientDebtSchema = z
  .object({
    action: z.enum(["clear", "void"]),
    method: z.enum(PAYMENT_METHOD_VALUES).optional(),
    notes: z.string().optional(),
    // Why the debt is being written off — required for a void so the forgiveness
    // is never unexplained. Ignored for a clear (that records a real payment).
    reason: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "clear" && !v.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "A payment method is required to clear a debt.",
      });
    }
    if (v.action === "void" && !v.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required to void a debt.",
      });
    }
  });

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
    usdToLbp: z.coerce.number().positive().optional(),
    usdToEur: z.coerce.number().positive().optional(),
  })
  .refine((v) => v.usdToLbp !== undefined || v.usdToEur !== undefined, {
    message: "At least one rate must be provided",
  });

export const createProductSchema = z.object({
  name: z.string().trim().min(1),
  price: z.coerce.number().min(0),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  active: z.boolean().optional(),
});

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).optional(),
  price: z.coerce.number().min(0).optional(),
  cost: z.coerce.number().min(0).optional(),
  currency: z.enum(["USD", "LBP"]).optional(),
  active: z.boolean().optional(),
});

export const createReferrerSchema = z.object({
  name: z.string().trim().min(1),
  active: z.boolean().optional(),
});

export const updateReferrerSchema = z.object({
  name: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
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
  .superRefine((v, ctx) => refineMoneyCap(v.amount, v.currency, ctx, "amount")); // R5 cap

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
export type CreateConsultationInput = z.infer<typeof createConsultationSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdateVisitBasketInput = z.infer<typeof updateVisitBasketSchema>;
export type SettleVisitBasketInput = z.infer<typeof settleVisitBasketSchema>;
export type UpdateBloodSampleInput = z.infer<typeof updateBloodSampleSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type CreateSessionPlanInput = z.infer<typeof createSessionPlanSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffSupplementsInput = z.infer<typeof updateStaffSupplementsSchema>;
export type UpdateStaffConsultationFeeInput = z.infer<typeof updateStaffConsultationFeeSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateReferrerInput = z.infer<typeof createReferrerSchema>;
export type UpdateReferrerInput = z.infer<typeof updateReferrerSchema>;
export type UpdateServicePriceInput = z.infer<typeof updateServicePriceSchema>;
export type CreateServicePriceInput = z.infer<typeof createServicePriceSchema>;
export type UpdateClientDebtInput = z.infer<typeof updateClientDebtSchema>;
export type MedicalHistoryInput = z.infer<typeof medicalHistorySchema>;
