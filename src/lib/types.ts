import type { FoodListLanguage } from "./food-list";
import type { TenderCurrency } from "./money";

export type Role = "secretary" | "dietitian" | "admin";

/**
 * The denomination of an OBLIGATION — a catalog price, a basket line, a visit
 * discount, a client debt, a session plan, an expense. Deliberately NOT widened
 * to EUR: the clinic bills and is owed in USD (LBP survives for legacy pricing),
 * and turning a bill into a foreign-currency obligation is explicitly out of
 * scope. Money the patient hands over is a different axis — see `TenderCurrency`
 * in `lib/money.ts`.
 */
export type Currency = "USD" | "LBP";

// Single source of truth for payment methods: the option list every method
// dropdown renders (in order), the labels they show, and the values the server
// validates against. Add or reorder here and it flows everywhere.
export const PAYMENT_METHOD_VALUES = [
  "cash",
  "card",
  "whish",
  "omt",
  "jessy",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  whish: "Whish",
  omt: "OMT",
  jessy: "Jessy",
};

// Third-party/prepaid payer: the patient settles through Jessy, so the money is
// recognized as income immediately (a normal Payment, counted in every
// method breakdown) while Jessy itself still owes the clinic that amount — a
// JessyReceivable, tracked separately from patient debt. See src/server/
// repositories/jessy.ts.
export const JESSY_METHOD: PaymentMethod = "jessy";

// Methods offered when recording an EXPENSE (money the clinic pays out). Jessy is
// a patient-payment channel the clinic collects THROUGH, never one it spends
// from, so it's excluded here — the receivable pipeline has no meaning for an
// outgoing cost.
export const EXPENSE_PAYMENT_METHOD_VALUES = PAYMENT_METHOD_VALUES.filter(
  (m) => m !== JESSY_METHOD,
);

// Sentinel bucket for payments whose stored method is genuinely blank/missing.
// A real, non-empty method value NEVER lands here — not even one that was once
// offered and later removed from the active choices above; those keep their own
// original value (see paymentMethodLabel).
export const PAYMENT_METHOD_OTHER_LABEL = "Other";

// Display label for whatever method value is actually stored on a payment record.
// Reads the record dynamically, not the currently-offered list: a known method
// uses its configured label; any OTHER non-empty stored value (e.g. a method
// retired from the choices above) displays under its own real, original value,
// forever. Only a blank/whitespace value falls back to "Other".
export function paymentMethodLabel(method: string | null | undefined): string {
  const raw = (method ?? "").trim();
  if (raw === "") return PAYMENT_METHOD_OTHER_LABEL;
  return PAYMENT_METHOD_LABELS[raw as PaymentMethod] ?? raw;
}

// Turns a {rawStoredMethod → amount} map into the ordered, non-zero rows the
// breakdown modal renders. Active methods come first in their configured order,
// then any other real (retired-but-recorded) method alphabetically, and the
// blank "Other" bucket always last. Pure + UI-free so it can be unit-tested.
export function paymentMethodBreakdownRows(
  byMethod: Record<string, number>,
): { key: string; label: string; amount: number }[] {
  const order = new Map<string, number>(PAYMENT_METHOD_VALUES.map((m, i) => [m as string, i]));
  const isOther = (key: string) => key.trim() === "";
  return Object.entries(byMethod)
    .map(([key, amount]) => ({ key, label: paymentMethodLabel(key), amount }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => {
      if (isOther(a.key) !== isOther(b.key)) return isOther(a.key) ? 1 : -1;
      const ai = order.has(a.key) ? (order.get(a.key) as number) : Number.POSITIVE_INFINITY;
      const bi = order.has(b.key) ? (order.get(b.key) as number) : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label);
    });
}
export type ServicePriceKind = "blood_test" | "treatment";

export interface ClinicSettings {
  usdToLbp: number;
  usdToEur: number;
  // Fee percent added to a card payment (e.g. 10 = 10%). 0 disables it.
  cardSurchargePercent: number;
}

// Sellable product/add-on (catalog). Prices are admin-managed. `cost` is the
// clinic's own cost, admin-only — omitted from responses to other roles.
export interface Product {
  id: string;
  name: string;
  price: number;
  cost?: number;
  currency: Currency;
  active: boolean;
  // Current on-hand count. May be negative (oversold) — see docs/known-issues.md.
  // Visible to every role, unlike cost.
  stock: number;
  lowStockThreshold: number;
}

// Admin-managed Botox catalog: a name and a default/base price. The base price
// is only ever a STARTING POINT for a visit line — the doctor sets the actual
// charged price per patient (see ConsultationBotoxItem). `cost` is the clinic's
// own cost, admin-only — omitted from responses to other roles, like Product.
export interface BotoxItem {
  id: string;
  name: string;
  price: number;
  cost?: number;
  currency: Currency;
  active: boolean;
}

// Admin-editable referrer (who sent the patient). The chosen name is snapshotted
// onto Client.referralSource, so this list only drives the selection dropdown.
export interface Referrer {
  id: string;
  name: string;
  active: boolean;
  // Admin-set per-referral commission in USD (0 = no fee). The LIVE rate; the
  // amount owed for a given patient is frozen onto the client at registration.
  // Admin-only, like every other cost/margin figure — omitted from responses
  // to other roles (see withoutFee).
  fee?: number;
}

// Admin-managed prices for blood tests and treatment services. `cost` is the
// clinic's own cost, admin-only — omitted from responses to other roles.
export interface ServicePrice {
  id: string;
  kind: ServicePriceKind;
  key: string;
  name: string;
  price: number;
  cost?: number;
  currency: Currency;
  active: boolean;
  // Treatment body-part presets: undefined = free-text entry, [] = no body-part
  // field, ["Abdomen", …] = fixed checklist. Unused (undefined) for blood tests.
  bodyParts?: string[];
}
export type AppointmentStatus =
  | "scheduled"
  | "checked_in"
  | "with_dietitian"
  | "completed"
  | "cancelled"
  | "no_show";
// Single source of truth for appointment visit types: the option list every
// visit-type dropdown renders (in order), the labels they show, and the values
// the server validates against. Add or reorder here and it flows everywhere.
export const VISIT_TYPE_VALUES = ["initial", "follow_up", "machines", "blood_test", "buy_products"] as const;
export type VisitType = (typeof VISIT_TYPE_VALUES)[number];
export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  initial: "Initial",
  follow_up: "Follow-up",
  machines: "Machines",
  blood_test: "Blood Test",
  buy_products: "Buy Products",
};
export type MaritalStatus = "single" | "married" | "divorced" | "widowed" | "other";

export interface StaffUser {
  id: string;
  fullName: string;
  email: string;
  phone?: string;
  role: Role;
  status: "active" | "inactive";
  // A dietitian's personal "Recommended supplements" options (empty = not
  // customized; the consultation screen falls back to the standard SUPPLEMENTS).
  supplements: string[];
  // Admin-configured consultation fee (USD) auto-added to a visit basket when this
  // dietitian runs the consultation. Undefined = no fee set. A client-facing price
  // (not clinic cost), so it's returned to every role.
  consultationFee?: number;
  // Admin-granted: this dietitian may see/use the Botox section in the
  // consultation editor. Always true in effect for an admin (checked
  // server-side by role, not this flag) and irrelevant for a secretary.
  canOfferBotox?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface Package {
  id: string;
  name: string;
  description: string;
  price: number;
  cost?: number; // clinic's own cost, admin-only — omitted from responses to other roles
  currency: Currency;
  sessions: number;
  discountPercent: number;
  status: "active" | "inactive";
  // Treatment type (e.g. "EMS") this bundle is scoped to; undefined = a general/
  // nutrition package offered for any treatment. See ServicePrice for the catalog.
  machine?: string;
}

export interface ClientPackage {
  id: string;
  packageName: string;
  price: number;
  currency: Currency;
  totalSessions: number;
  usedSessions: number;
  machine?: string;
  startDate: string;
  status: "active" | "completed" | "cancelled";
}

export type SessionPlanStatus = "active" | "completed" | "cancelled";

// Per-session treatment tracking for a client NOT on a fixed-price bundle.
// SEPARATE system from ClientPackage, same prepaid principle: sessions are bought
// as basket lines, and settling that basket (paid now or moved to a ClientDebt)
// is what makes them usable.
export interface SessionPlan {
  id: string;
  clientId: string;
  machine?: string;
  unitPrice: number;
  currency: Currency;
  usdToLbp: number;
  // The PRESCRIBED course length — clinical intent, bills nothing by itself.
  sessionsNeeded: number;
  // Sessions delivered.
  sessionsUsed: number;
  // Sessions PURCHASED AND SETTLED — the supply everything draws on.
  sessionsPaid: number;
  status: SessionPlanStatus;
  // Derived: sessions bought, settled and not yet used. A machine visit may
  // consume only these.
  sessionsAvailable: number; // max(0, sessionsPaid - sessionsUsed)
  // Derived: how many more times the client physically needs to come in.
  sessionsLeftToAttend: number; // max(0, sessionsNeeded - sessionsUsed)
  // Derived: sessions already SOLD on a basket that has not been settled yet.
  // Bought but not usable — settling that basket is what unlocks them.
  sessionsPendingPurchase: number;
  // Derived: prescribed sessions nobody has sold yet (a sale still to be made).
  sessionsToBuy: number; // max(0, sessionsNeeded - sessionsPaid - sessionsPendingPurchase)
  createdAt: string;
}

// ---- Machine visits ----
// A patient who came in only to use sessions they already own. Not a
// consultation: no clinical data, no visit number. Not a sale either: it consumes
// available sessions and never charges. Merged with consultations only for
// display (client history, attendance figures).
export type MachineVisitStatus = "recorded" | "voided";

export interface MachineVisitItem {
  id: string;
  /** Catalog machine key, or null when the plan/bundle this line drew on is not
   * tied to a machine. Render it through NO_MACHINE_LABEL, never as "Other". */
  machine: string | null;
  sessions: number;
  // Historic only — always 0 now that a machine visit is pure consumption. On
  // older rows: sessions this line billed because credit didn't cover them.
  billedSessions: number;
  unitPrice: number;
  currency: Currency;
  sessionPlanId?: string;
  clientPackageId?: string;
}

export interface MachineVisit {
  id: string;
  clientId: string;
  clientName: string;
  date: string;
  note?: string;
  status: MachineVisitStatus;
  recordedByName: string;
  appointmentId?: string;
  items: MachineVisitItem[];
  sessionsTotal: number;
  // A machine visit only consumes sessions the patient already owns, so it never
  // charges: both of these are 0/absent on every visit recorded since, and
  // non-zero only on historic rows that predate settle-before-use.
  amountDue: number;
  pendingBasketId?: string;
  voidedAt?: string;
  voidedByName?: string;
  voidReason?: string;
}

/** One machine's workload over a period.
 *
 * NOTE THE UNITS — three of these fields count SESSIONS and one counts VISITS,
 * which is why they are named apart rather than left to a column header:
 *   sessions             = total sessions delivered on the machine (the workload)
 *                        = machineVisitSessions + consultationSessions
 *   machineVisitSessions = of those, sessions delivered at a machine-only visit
 *   consultationSessions = of those, sessions delivered inside a consultation
 *   machineVisits        = how many machine-only VISITS delivered them
 */
export interface MachineUtilizationRow {
  machine: string;
  sessions: number;
  machineVisitSessions: number;
  machineVisits: number;
  consultationSessions: number;
}

// ---- Visit services ----
// Blood tests are admin-managed in the ServicePrice catalog (kind "blood_test"),
// exactly like treatment types — there is no hardcoded list. "Other" is the
// catalog's fallback bucket for custom, one-off test names.

// Supplements a dietitian commonly recommends. The consultation notes offer
// these in a dropdown; "Other" lets the dietitian type a custom recommendation.
export const SUPPLEMENTS = [
  "Multivitamin",
  "Vitamin D",
  "Vitamin B12",
  "Vitamin C",
  "Omega-3 (Fish oil)",
  "Magnesium",
  "Iron",
  "Calcium",
  "Zinc",
  "Folic acid",
  "Probiotics",
  "Whey protein",
  "Collagen",
] as const;

// Treatment types (machines) and their body-part presets are now admin-managed
// in the ServicePrice catalog (kind "treatment"); see ServicePrice.bodyParts for
// the preset semantics. The old MACHINES / BODY_PARTS consts were removed.

/** How a missing machine is shown. A line can legitimately have no machine; what
 * it must never have is a made-up one. "Other" as a machine identity is gone —
 * it let one physical machine be filed under two different names. */
export const NO_MACHINE_LABEL = "No machine";

export interface ConsultationTreatment {
  id?: string;
  /** A key from the treatment catalog (ServicePrice, kind "treatment"). There is
   * no custom/"Other" machine and no free-text alternative — see the schema. */
  machine: string;
  bodyParts: string[];
  sessionsNeeded: number;
  sessionsUsed: number;
  price?: number;
  currency?: Currency;
  clientPackageId?: string;
  packageName?: string;
  // Set when the sessions were drawn from a pay-as-you-go session plan (separate
  // from packages), so history can label it as such.
  sessionPlanId?: string;
  notes?: string;
}

export interface ConsultationBloodTestCharge {
  name: string;
  price: number;
  currency: Currency;
}

export interface ConsultationServiceTotal {
  currency: Currency;
  subtotal: number;
  discount: number;
  total: number;
}

export interface ConsultationProduct {
  id?: string;
  // Permanent catalog reference captured at sale time; the sold line is matched
  // back to the catalog by this id (not name), so it survives a later rename or
  // delete. Undefined only for legacy rows sold before this existed.
  productId?: string;
  name: string;
  quantity: number;
  amount: number;
  // Frozen per-unit price at time of sale (stored, not amount ÷ quantity), so a
  // quantity change on a historical line stays exact. Undefined for legacy rows.
  unitPrice?: number;
  currency?: Currency;
  notes?: string;
}

// A Botox charge on one visit. Unlike a treatment or product, its price is set
// by the doctor per patient rather than fixed from the catalog — `basePrice` is
// the admin's catalog default at the moment this line was (last) priced,
// carried for reference/audit only; `chargedPrice` is the actual, authoritative
// amount billed. `paid` marks a line that has already been settled — once true
// the editor must treat botoxItemId/chargedPrice/quantity as locked, since this
// app has no refund/reversal concept (see docs/known-issues.md).
export interface ConsultationBotoxItem {
  id?: string;
  botoxItemId?: string;
  name: string;
  basePrice: number;
  chargedPrice: number;
  quantity: number;
  currency?: Currency;
  notes?: string;
  paid: boolean;
}

export type ConsultationStatus = "open" | "closed";

export interface Consultation {
  id: string;
  clientId: string;
  // The doctor who owns this visit. An unclosed visit may only be edited/closed
  // by them or an admin — enforced server-side, mirrored in the UI.
  dietitianId?: string;
  dietitianName: string;
  date: string;
  visitNumber: number;
  // An evolving visit: "open" is an editable draft settled in installments;
  // "closed" is final and read-only.
  status: ConsultationStatus;
  weightKg?: number;
  heightCm?: number;
  bmi?: number;
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
  bloodTestCharges?: ConsultationBloodTestCharge[];
  nurseRequired?: boolean;
  visitDiscountType?: "percent" | "amount";
  visitDiscountValue?: number;
  visitDiscountReason?: string;
  visitDiscountCurrency?: Currency;
  visitServiceTotals?: ConsultationServiceTotal[];
  // Consultation fee frozen at creation (USD) from the visit dietitian's configured
  // fee. Undefined = no fee applied. `consultationFeeWaived` = the dietitian removed
  // the fee line from this visit's basket.
  consultationFee?: number;
  consultationFeeWaived?: boolean;
  treatments?: ConsultationTreatment[];
  products?: ConsultationProduct[];
  botoxItems?: ConsultationBotoxItem[];
  // The Nutrient-Rich Foods List filled in on this visit, if the doctor opened it.
  foodList?: ConsultationFoodList;
}

/** The Food List form as saved against a visit. `selections` holds catalog item
 * ids (see `src/lib/food-list.ts`); `patientName` defaults to the patient's name
 * but stays editable, so it's stored rather than derived. */
export interface ConsultationFoodList {
  language: FoodListLanguage;
  patientName: string;
  notes?: string;
  selections: string[];
  updatedAt: string;
}

export interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
  // The doctor this visit is booked with / checked in to. Drives per-doctor
  // queue filtering — a doctor's board shows only their own appointments.
  dietitianId?: string;
  dietitianName: string;
  date: string;
  time: string;
  status: AppointmentStatus;
  visitType: VisitType;
  // Set when the appointment was completed (visit closed). ISO timestamp; the
  // queue's "Done" list keys off its local day so a visit closed today shows today.
  completedAt?: string;
  notes?: string;
  referralSource?: string;
  intakeComplete: boolean;
  firstTimePatient: boolean;
  hasMedicalHistory?: boolean;
}

export interface Payment {
  id: string;
  // Optional: a payment may be tied to a patient, or be a general clinic payment.
  clientId?: string;
  clientName?: string;
  // What the payment is for (its reason).
  motif: string;
  // Amount actually received. There is no paid-vs-total split; any remainder a
  // client owes lives in ClientDebt, not on the payment.
  amountPaid: number;
  // The currency the money was physically TENDERED in. A payment may be taken in
  // USD, EUR or LBP whatever the obligation it settles — the obligation itself
  // stays USD (see `Currency`).
  currency: TenderCurrency;
  // Exchange rate (1 USD = ? LBP) snapshotted when the payment was logged. Kept
  // for every payment (and the only rate legacy rows carry); superseded by
  // `fxRate` for valuing this row.
  usdToLbp: number;
  // Units of THIS payment's `currency` per 1 USD, frozen at the moment it was
  // recorded. `amountPaid / fxRate` is its USD value, forever — reports use this,
  // never today's Settings, so changing a rate never re-prices history. Null only
  // on rows written before multi-currency tender existed (USD or LBP, where
  // `usdToLbp` means exactly the same thing).
  fxRate?: number;
  // `amountPaid / fxRate` — the USD the clinic accounts for. Precomputed by the
  // server so no client ever has to (or gets to) do FX maths on money.
  amountUsd: number;
  // Portion of `amountPaid` that is the card-payment surcharge fee (0 for every
  // non-card payment). The original, pre-surcharge amount is amountPaid - this.
  cardSurchargeAmount: number;
  method: PaymentMethod;
  date: string;
  receiptNumber: string;
  notes?: string;
  // Who collected/recorded the money (resolved from the acting user), so every
  // payment is traceable to a person. Missing only on rows logged before this
  // was tracked.
  createdByName?: string;
}

// ---- Visit basket (dietitian → secretary settlement) ----
// `closed` is the terminal state: the secretary settled it (fully paid, or with an
// unpaid balance recorded as a tracked ClientDebt), then the dietitian closed the
// visit — so it's retired from the settlement queue (the client has moved on to
// Done). Kept for audit; a paid basket only lingers on the board while its visit
// is still open.
export type VisitBasketStatus = "pending" | "paid" | "closed";
// `consultation_fee` is the auto-added visit fee line. It's a distinct kind (not
// a plain "custom" line) so the secretary's settlement UI/API can lock it — only
// the dietitian (in their editor) or an admin may waive it.
export type VisitBasketItemKind =
  | "blood_test"
  | "treatment"
  | "product"
  // A prepaid bundle sale. Its own kind rather than "custom" so it can be
  // price-protected at checkout and traced to the ClientPackage it created —
  // an anonymous custom line could be neither.
  | "package"
  | "custom"
  | "consultation_fee"
  // A Botox charge, doctor-priced per visit. See ConsultationBotoxItem.
  | "botox";

export interface VisitBasketItem {
  id?: string;
  kind: VisitBasketItemKind;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
  covered: boolean;
  // Frozen share of the bill-level discount allocated to this line at settlement.
  // A discount is not a price edit: `unitPrice` stays the original, auditable
  // price and this is the reduction, separately. Sale value for the line is
  // `unitPrice * quantity - discountAmount`.
  discountAmount?: number;
  // Set on pay-as-you-go session lines so the plan link survives a secretary edit
  // and its settled quantity advances the plan's sessionsPaid. Absent otherwise.
  sessionPlanId?: string;
  // Set on a "product" line so it survives a secretary edit — settlement deducts
  // inventory by the final settled quantity per product. Absent otherwise.
  productId?: string;
  // The prepaid bundle this line sells.
  clientPackageId?: string;
  // Set on a "botox" line — the ConsultationBotoxItem this charge belongs to,
  // which is what the paid-line lock keys on. Absent otherwise.
  consultationBotoxItemId?: string;
}

export interface VisitBasket {
  id: string;
  clientId: string;
  clientName: string;
  consultationId?: string;
  // The doctor who owns this basket, used to scope a doctor's own queue view.
  dietitianId?: string;
  dietitianName: string;
  status: VisitBasketStatus;
  discountType?: "percent" | "amount";
  discountValue: number;
  discountReason?: string;
  currency: Currency;
  usdToLbp: number; // exchange-rate snapshot at basket creation (see Payment.usdToLbp)
  items: VisitBasketItem[];
  subtotal: number;
  discount: number;
  total: number;
  sentAt: string;
  paidAt?: string;
  paymentId?: string;
  // Primary (first) receipt of the settlement — kept for existing single-receipt
  // display. When the settlement was split across methods, every portion's method,
  // USD amount, and receipt is in `paymentSplits` (and `receiptNumber` is the
  // first of them).
  receiptNumber?: string;
  // One entry per method the settlement was collected with (empty for an unpaid
  // or $0 basket). Lets a settled basket show the split clearly, e.g. Cash $100 ·
  // Whish $200, each with its own receipt. `amount` is the basket-attributable
  // portion (excludes any card surcharge, so the entries sum to `total` above);
  // `cardSurchargeAmount` is the fee on top (0 for every non-card entry).
  // `amount` is the USD-equivalent portion; `nativeAmount`/`currency`/`fxRate`
  // record what was physically handed over, so a mixed-currency settlement stays
  // auditable back to the notes on the counter.
  paymentSplits?: {
    method: PaymentMethod;
    currency: TenderCurrency;
    nativeAmount: number;
    fxRate: number;
    amount: number;
    cardSurchargeAmount: number;
    receiptNumber: string;
  }[];
}

// ---- Blood sample tracking (lab logistics) ----
// Derived from the two timestamps: no send yet → "pending"; sent, no results →
// "sent"; results back → "received".
export type BloodSampleStatus = "pending" | "sent" | "received";

export interface BloodSample {
  id: string;
  clientId: string;
  clientName: string;
  consultationId?: string;
  dietitianName: string;
  tests: string[];
  status: BloodSampleStatus;
  orderedAt: string; // ISO timestamp of the order (consultation)
  sentAt?: string; // ISO timestamp the sample left for the lab
  receivedAt?: string; // ISO timestamp the results came back
  notes?: string;
}

/** A file (lab result / scan) attached to a specific blood test. Metadata only —
 * the bytes are streamed from the download endpoint, never carried in JSON. */
export interface BloodSampleFile {
  id: string;
  bloodSampleId: string;
  filename: string;
  mimeType: string;
  size: number; // bytes
  uploadedById: string | null; // User who uploaded (null if since removed) — lets the UI offer self-delete
  uploadedByName: string;
  createdAt: string; // ISO timestamp of upload
}

/** A blood-test file plus the context of the test it hangs off — powers the
 * client profile's Files tab, which lists every blood attachment for a patient. */
export interface ClientBloodFile extends BloodSampleFile {
  clientId: string;
  tests: string[];
  orderedAt: string; // ISO timestamp of the order the file belongs to
}

/** A file generated against a consultation — today the Food List PDF. Same shape
 * as BloodSampleFile, but unrestricted: every role may download it. */
export interface ConsultationFile {
  id: string;
  consultationId: string;
  kind: "food-list";
  filename: string;
  mimeType: string;
  size: number; // bytes
  uploadedById: string | null;
  uploadedByName: string;
  createdAt: string; // ISO timestamp
  /** The Food List was edited after this PDF was generated, so it prints the old
   * answers. Sending it would hand the patient a superseded form, so the send
   * button refuses on it — see `isFoodListPdfStale`. */
  stale: boolean;
}

/** A consultation file plus the visit it belongs to — powers the client profile's
 * Files tab, which lists every generated document for a patient. */
export interface ClientConsultationFile extends ConsultationFile {
  clientId: string;
  visitNumber: number;
  visitDate: string; // ISO timestamp of the consultation
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  currency: Currency;
  usdToLbp: number; // exchange-rate snapshot when logged (see Payment.usdToLbp)
  date: string;
  paidBy: string;
  method: PaymentMethod;
  notes?: string;
  // "operating" (a normal running cost, counted as an operating expense) or
  // "referral_commission" (already recognized on the commission ledger, so it is
  // EXCLUDED from operating expenses rather than counted a second time).
  kind: "operating" | "referral_commission";
  amountEdited?: boolean;
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other" | "unspecified";
  address?: string;
  emergencyContact?: string;
  medicalNotes?: string;
  allergies?: string;
  passportNumber?: string;
  country?: string;
  maritalStatus?: MaritalStatus;
  referralSource?: string;
  firstTimePatient?: boolean;
  hasMedicalHistory: boolean;
  // Derived, never stored: the patient still has treatment sessions to finish
  // (an active bundle or session plan with sessions remaining).
  active: boolean;
  // Derived, never stored: the patient's most recent visit is over a year old.
  // Distinct from `active`; the UI shows "Active" in preference when both hold.
  inactive: boolean;
  intakeComplete: boolean;
  assignedDietitian?: string;
  assignedDietitianId?: string;
  registeredAt: string;
  packages: ClientPackage[];
}

// ---- Medical history ----
export const MEDICAL_CONDITIONS = [
  "Diabetes Type 1 / Type 2",
  "Thyroid disorders",
  "High blood pressure",
  "High cholesterol / triglycerides",
  "Heart disease",
  "PCOS / irregular menstrual periods",
  "Gastrointestinal disorders",
  "Kidney disease",
  "Liver conditions",
  "Autoimmune disorders",
  "Depression / anxiety",
  "Eating disorders",
  "Intolerance diagnosed by a doctor",
  "Other",
] as const;

export const FAMILY_CONDITIONS = [
  "Diabetes",
  "Thyroid disorders",
  "Obesity",
  "Heart disease",
  "Hypertension",
  "Cancer",
  "Other",
] as const;

// Lifestyle quick-pick presets (medical history → Lifestyle). Stored as plain
// strings on the record; the form offers them as pills instead of free text so
// answers stay consistent. Exercise type is multi-select (a patient may do
// several); the rest are single-select ranges.
export const EXERCISE_TYPES = [
  "Weight lifting",
  "Running",
  "Walking",
  "Dancing",
  "Pilates",
  "Sport",
] as const;

export const WATER_GLASSES = [
  "Less than 2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9+",
] as const;

export const CIGARETTES_PER_DAY = [
  "Less than 1/4 pack",
  "1/4 pack",
  "Half pack",
  "3/4 pack",
  "1 pack",
  "2+ packs",
] as const;

export const SLEEP_HOURS = [
  "Less than 3 hours",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10+ hours",
] as const;

// How often the patient drinks alcohol (single-select; ranges cover every case).
export const ALCOHOL_FREQUENCY = [
  "Rarely",
  "Monthly",
  "Weekly",
  "2-3x / week",
  "4-6x / week",
  "Daily",
] as const;

// Exercise sessions per week (single-select, 1–7).
export const EXERCISE_FREQUENCY = ["1", "2", "3", "4", "5", "6", "7"] as const;

// Yes/No questions are tri-state: true = yes, false = no, null = not answered.
export interface MedicalHistory {
  conditions: string[];
  intoleranceDetail?: string;
  conditionsOther?: string;
  medicalHistoryNote?: string;

  hasAllergies: boolean | null;
  allergiesDetail?: string;

  takingMedications: boolean | null;
  medicationsDetail?: string;
  takingSupplements: boolean | null;
  supplementsDetail?: string;
  hadSurgeries: boolean | null;
  surgeriesDetail?: string;

  familyHistory: string[];
  familyCancerDetail?: string;
  familyOther?: string;
  familyHistoryNote?: string;

  drinksWater: boolean | null;
  waterGlasses?: string;
  drinksCaffeine: boolean | null;
  drinksAlcohol: boolean | null;
  alcoholFrequency?: string;
  smokes: boolean | null;
  cigarettesPerDay?: string;
  exercises: boolean | null;
  exerciseType?: string;
  exerciseFrequency?: string;
  sleepHours?: string;
  wakesRested: boolean | null;
  feelsStressed: boolean | null;
  followsDiet: boolean | null;
  snacksFrequently: boolean | null;
  feelsFatigued: boolean | null;
  moodSwings: boolean | null;

  /** Free-text notes keyed by lifestyle question (see LIFESTYLE_NOTE_KEYS). */
  lifestyleNotes: Partial<Record<LifestyleNoteKey, string>>;

  updatedAt?: string;
}

// Lifestyle questions a note can be attached to — one per YesNo/quick-pick
// question in the Lifestyle card, keyed to match the FormState field name.
export const LIFESTYLE_NOTE_KEYS = [
  "drinksWater",
  "drinksCaffeine",
  "drinksAlcohol",
  "smokes",
  "exercises",
  "sleepHours",
  "wakesRested",
  "feelsStressed",
  "followsDiet",
  "snacksFrequently",
  "feelsFatigued",
  "moodSwings",
] as const;
export type LifestyleNoteKey = (typeof LIFESTYLE_NOTE_KEYS)[number];

export interface AuditEntry {
  id: string;
  user: string;
  action: string;
  entityType: string;
  entityLabel: string;
  timestamp: string;
}

// ---- Client debt (money owed but not collected when incurred) ----
export type ClientDebtStatus = "outstanding" | "cleared" | "voided";
// secretary_override — secretary recorded "still owes $X" at settlement (the
// unpaid/partial remainder deferred while the rest of the basket was collected)
export type ClientDebtSource = "secretary_override";

/**
 * One entry of the append-only exchange-rate history (Pricing → rate history).
 * Every field is server-derived; the client renders it and can never write it.
 */
export interface FxRateChangeEntry {
  id: string;
  rateKey: "usdToLbp" | "usdToEur";
  currency: TenderCurrency;
  /** Absent only for the first recorded change of a rate that was still unset. */
  oldValue?: number;
  newValue: number;
  /** The change tripped the suspicious-delta guard and an admin confirmed it anyway. */
  suspiciousOverride: boolean;
  changedByName: string;
  changedAt: string;
}

export interface TenderBreakdownEntry {
  method: string;
  currency: TenderCurrency;
  /** USD-equivalent, each payment at its own frozen rate. */
  usd: number;
  /** Sum of the NATIVE amounts — never normalised away, so the drawer can be counted. */
  native: number;
}

export interface ClientDebt {
  id: string;
  clientId: string;
  clientName: string;
  consultationId?: string;
  visitNumber?: number; // the visit this came from, for display
  // The PRINCIPAL owed, always in `currency`. Never re-priced: a $400 debt is
  // $400 whatever currency it is later paid in.
  amount: number;
  currency: Currency;
  usdToLbp: number; // exchange-rate snapshot (see Payment.usdToLbp)
  // USD already applied to this debt (0 until a partial payment lands). Money
  // tendered in EUR/LBP is converted at its own frozen rate before it lands here,
  // so the debt itself never carries FX exposure.
  paidAmount: number;
  // `amount` (in USD) minus `paidAmount` — what is still owed. Server-computed.
  outstandingAmount: number;
  reason: string;
  source: ClientDebtSource;
  status: ClientDebtStatus;
  createdByName?: string;
  clearedByName?: string;
  clearedAt?: string; // when it was collected (cleared) or written off (voided)
  createdAt: string;
}

// ---- Jessy receivables (money the third-party payer owes the clinic) ----
// A Jessy receivable is NOT patient debt: the patient's side of the visit is
// already settled by the Jessy payment (income recognized at once, see
// JESSY_METHOD). What remains is Jessy's own obligation to transfer that money,
// which is cleared by a JessySettlement — a collection of an existing
// receivable, never new income.
export type JessyReceivableStatus = "outstanding" | "settled";

export interface JessyReceivable {
  id: string;
  paymentId: string;
  receiptNumber: string;
  clientId?: string;
  clientName?: string;
  consultationId?: string;
  visitNumber?: number;
  // USD, converted at the rate frozen on the source payment. The payment's own
  // native amount/currency is one join away and never lost.
  amount: number;
  remaining: number;
  status: JessyReceivableStatus;
  createdByName?: string;
  createdAt: string;
}

export interface JessySettlementAllocation {
  receivableId: string;
  receiptNumber: string;
  clientName?: string;
  amount: number;
}

export interface JessySettlement {
  id: string;
  amount: number; // USD received from Jessy in this transfer
  reference?: string;
  notes?: string;
  recordedByName?: string;
  createdAt: string;
  // Which receivables this transfer paid off, oldest first (FIFO).
  allocations: JessySettlementAllocation[];
}

/** The three figures that must stay conceptually separate (see docs). */
export interface JessySummary {
  // Total patients have paid through Jessy, all time (already counted as income).
  recorded: number;
  // Total Jessy has actually transferred to the clinic.
  settled: number;
  // What Jessy still owes = recorded − settled. Never negative.
  outstanding: number;
}

export interface JessyReport {
  summary: JessySummary;
  receivables: JessyReceivable[];
  settlements: JessySettlement[];
}

// ---- Composed API response shapes ----

export interface ConsultationListItem extends Consultation {
  clientName: string;
}

export interface ClientDetail {
  client: Client;
  consultations: Consultation[];
  appointments: Appointment[];
  payments: Payment[];
  sessionPlans: SessionPlan[];
  // Tracked debts (money owed but not collected) — the single source of truth for
  // what a patient owes. There is no payment-based charged-minus-paid "balance".
  debts: ClientDebt[];
  debtTotal: number; // outstanding debts summed in USD at each debt's frozen rate
}

export interface RecentConsultation {
  id: string;
  clientId: string;
  clientName: string;
  dietitianName: string;
  date: string;
  visitNumber: number;
  weightKg?: number;
  deltaKg?: number;
}

export interface DashboardSummary {
  today: string;
  counts: {
    totalClients: number;
    activeClients: number;
    newToday: number;
    newThisMonth: number;
    consultations: number;
    // Machine-only visits recorded (voided ones excluded). Never folded into
    // `consultations` — a machine visit is attendance, not a consultation.
    machineVisits: number;
  };
  finance: {
    // ---- EARNED / PROFITABILITY (accrual, dated at transaction finalization) ----
    // Recognized when the sale is finalized, never when cash arrives and never
    // when a prepaid session is later used. See server/repositories/profitability.ts.
    revenue: number;            // net of discounts — what was actually charged
    grossRevenue: number;       // before discounts (original prices, kept visible)
    discounts: number;          // the reduction given, accounted separately
    cogs: number;               // frozen cost of what was sold
    grossProfit: number;        // revenue − cogs
    grossMarginPercent: number | null; // null when there is no revenue
    operatingExpenses: number;  // Expense rows (kind "operating") in the period
    referrerCost: number;       // referral commissions INCURRED in the period
    netProfit: number;          // grossProfit − operatingExpenses − referrerCost
    revenueByKind: { kind: string; revenue: number; cogs: number }[];

    // ---- CASH / COLLECTION (never mixed into the figures above) ----
    totalIncome: number;        // money COLLECTED in the period (payments)
    unpaidBalance: number;      // outstanding client debt — a balance, not windowed
    jessyOutstanding: number;   // owed by Jessy — a balance, not windowed
    referralOutstanding: number;// owed TO referrers — a balance, not windowed
    // ---- CASH ON HAND (what the period actually put in the till) ----
    // netCash = cashCollected − operatingExpenses − referrerPayouts. Every term is
    // dated when the money MOVED, so a sale on credit adds nothing until it is
    // collected and an old debt collected now counts here in full. COGS is
    // deliberately not subtracted — stock was paid for through its own Expense
    // row, and taking it out again would count the same money twice.
    referrerPayouts: number;    // cash paid TO referrers in the period (paidAt)
    // Jessy re-timed to when the money moves. A `jessy` Payment is income on the
    // day the patient pays but no cash yet, so it is REMOVED from the cash figure
    // (it stays in totalIncome); a settlement is the transfer actually arriving
    // and writes no Payment, so it is ADDED. Only this block does that.
    jessyIncome: number;        // jessy payments in the period (income, not cash)
    jessyReceived: number;      // settlements received from Jessy in the period
    cashCollected: number;      // totalIncome − jessyIncome + jessyReceived
    cashOut: number;            // operatingExpenses + referrerPayouts
    netCash: number;            // cashCollected − cashOut
    paymentsToday: number;
    incomeByMethod: Record<string, number>;
    paymentsTodayByMethod: Record<string, number>;
    incomeByTender: TenderBreakdownEntry[];
    paymentsTodayByTender: TenderBreakdownEntry[];
  };
  // Bundles SOLD in the selected period, counted from the settled `package`
  // basket lines — so this is windowed, and an abandoned draft's orphaned
  // ClientPackage row is not a sale and is not counted.
  packagesSold: number;
  mostPopularPackage: string;
  todaysAppointments: Appointment[];
  recentPayments: Payment[];
  recentConsultations: RecentConsultation[];
  staffActivity: { name: string; role: Role; consults: number; machineVisits: number }[];
  // EARNED profit trend, last 6 months. Never collections — cash belongs to the
  // Cash & balances figures. `costs` = COGS + operating expenses + referrer
  // commissions incurred, so `netProfit` here equals the Net profit card when the
  // same month is selected as the period.
  profitSeries: { month: string; revenue: number; costs: number; netProfit: number }[];
  // The most profitable bundles in the selected period, from the finalized
  // package sales. `name` is the name FROZEN on each sale, so renaming a bundle
  // in the catalog never restates a closed period. Revenue is what was charged
  // after discount and cogs is the cost frozen at the sale — later session usage
  // does not move either, because a prepaid bundle is recognized in full when it
  // is bought. Admin-only, like every other cost figure.
  packageRevenue: {
    name: string;
    sales: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPercent: number | null;
  }[];
  // The five machines with the most SESSIONS delivered in the selected period.
  // Sliced from `machineUtilization`, so it is the same period, boundaries and
  // canonical machine identity — the chart cannot rank a machine differently from
  // the table it sits next to. Ranked by sessions rather than visits because one
  // visit can carry several sessions. Excludes the "no machine" bucket.
  topMachines: { machine: string; sessions: number; machineVisits: number }[];
  appointmentBreakdown: { name: string; value: number; color: string }[];
  // Clients with money owed; `balance` holds their outstanding tracked debt (USD).
  unpaidClients: { id: string; name: string; balance: number }[];
  // Patients grouped by the external referrer who sent them, windowed by
  // registration date. `name` is the FROZEN referralSource snapshot recorded on
  // the client, so a referrer later renamed/deactivated/deleted still appears
  // here under the exact name captured at the time. `patients` is the roster
  // behind the count (id + name), for the expandable drill-down.
  referrerReport: {
    name: string;
    count: number;
    patients: { id: string; name: string }[];
  }[];
  // Referrer-cost breakdown behind the "Referrer cost" figure: each referrer that
  // was owed a commission for patients registered in the period, the total owed
  // (sum of frozen per-patient fees, USD), and the patients that drove it. Only
  // referrers with a non-zero owed total appear. `fee` on each patient is the
  // frozen amount attributed to that specific registration. Admin-only.
  referrerCostReport: {
    name: string;
    total: number;
    patients: { id: string; name: string; fee: number }[];
  }[];
  // Machine usage over the selected period: sessions delivered per machine and
  // how many machine-only visits delivered them. `consultationSessions` is the
  // part that came through a consultation instead, so the row reads as total
  // utilization with the machine-visit share visible inside it.
  machineUtilization: MachineUtilizationRow[];
  // The five blood tests ordered most often in the selected period, with how many
  // lab orders each appeared on. Counted from the lab orders themselves (see
  // topBloodTests), so cancelled orders and tests removed before the lab never
  // show up. Names are the frozen snapshots stored on the order. Clinical volume,
  // not money — not redacted.
  topBloodTests: { name: string; count: number }[];
}


/** The referral-commission ledger (admin only). Mirrors `JessyReport` in shape:
 * three headline figures that must never be conflated, plus the rows behind them.
 *
 *   incurred    — recognized as an EXPENSE, once, when the commission arose
 *   paid        — CASH paid out to referrers; never an expense a second time
 *   outstanding — a BALANCE (incurred − paid − voided), never windowed
 */
export interface ReferralReport {
  summary: { incurred: number; paid: number; outstanding: number };
  commissions: {
    id: string;
    clientId: string;
    clientName: string;
    referrerName: string;
    amount: number;
    incurredAt: string;
    triggerType: string;
    status: string;
    paidAt?: string;
    voidReason?: string;
  }[];
  payouts: {
    id: string;
    referrerName: string;
    amount: number;
    reference?: string;
    notes?: string;
    paidAt: string;
    recordedByName?: string;
    commissionCount: number;
    clients: { clientId: string; clientName: string; amount: number }[];
  }[];
}
