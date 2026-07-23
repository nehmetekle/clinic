export type Role = "secretary" | "dietitian" | "admin";

export type Currency = "USD" | "LBP";

// Single source of truth for payment methods: the option list every method
// dropdown renders (in order), the labels they show, and the values the server
// validates against. Add or reorder here and it flows everywhere.
export const PAYMENT_METHOD_VALUES = [
  "cash",
  "card",
  "whish",
  "omt",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  whish: "Whish",
  omt: "OMT",
};

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
}

// Admin-editable referrer (who sent the patient). The chosen name is snapshotted
// onto Client.referralSource, so this list only drives the selection dropdown.
export interface Referrer {
  id: string;
  name: string;
  active: boolean;
  // Admin-set per-referral commission in USD (0 = no fee). The LIVE rate; the
  // amount owed for a given patient is frozen onto the client at registration.
  fee: number;
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

// Pay-as-you-go session tracking for a client NOT on a fixed-price package.
// SEPARATE system from ClientPackage. `sessionsUsed` counts sessions delivered;
// `sessionsPaid` counts sessions paid for (only advances at settlement). The
// derived fields below are computed server-side from those raw counts.
export interface SessionPlan {
  id: string;
  clientId: string;
  machine?: string;
  unitPrice: number;
  currency: Currency;
  usdToLbp: number;
  sessionsNeeded: number;
  sessionsUsed: number;
  sessionsPaid: number;
  status: SessionPlanStatus;
  // Derived (never stored): prepaid-but-unused sessions available to auto-cover
  // future visits.
  credit: number; // max(0, sessionsPaid - sessionsUsed)
  // Derived: how many more times the client physically needs to come in.
  sessionsLeftToAttend: number; // max(0, sessionsNeeded - sessionsUsed)
  // Derived: sessions still owing payment.
  sessionsToPayFor: number; // max(0, sessionsNeeded - sessionsPaid)
  createdAt: string;
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

export interface ConsultationTreatment {
  id?: string;
  machine: string;
  machineOther?: string;
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

export type ConsultationStatus = "open" | "closed";

export interface Consultation {
  id: string;
  clientId: string;
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
}

export interface Appointment {
  id: string;
  clientId: string;
  clientName: string;
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
  currency: Currency;
  // Exchange rate (1 USD = ? LBP) snapshotted when the payment was logged. Reports
  // convert this record with this rate, never today's — so history never shifts.
  usdToLbp: number;
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
  | "custom"
  | "consultation_fee";

export interface VisitBasketItem {
  id?: string;
  kind: VisitBasketItemKind;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
  covered: boolean;
  // Set on pay-as-you-go session lines so the plan link survives a secretary edit
  // and its settled quantity advances the plan's sessionsPaid. Absent otherwise.
  sessionPlanId?: string;
}

export interface VisitBasket {
  id: string;
  clientId: string;
  clientName: string;
  consultationId?: string;
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
  // Whish $200, each with its own receipt.
  paymentSplits?: { method: PaymentMethod; amount: number; receiptNumber: string }[];
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

  updatedAt?: string;
}

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

export interface ClientDebt {
  id: string;
  clientId: string;
  clientName: string;
  consultationId?: string;
  visitNumber?: number; // the visit this came from, for display
  amount: number;
  currency: Currency;
  usdToLbp: number; // exchange-rate snapshot (see Payment.usdToLbp)
  reason: string;
  source: ClientDebtSource;
  status: ClientDebtStatus;
  createdByName?: string;
  clearedByName?: string;
  clearedAt?: string; // when it was collected (cleared) or written off (voided)
  createdAt: string;
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
  };
  finance: {
    totalIncome: number; // payments dated within the selected period (all-time if none)
    totalExpenses: number; // operating expenses dated within the selected period
    netProfit: number; // income − operating expenses − referrer cost (COGS excluded, by design)
    cogs: number; // cost of goods sold: frozen ClientPackage.cost for sales in the period
    grossMargin: number; // income − (operating expenses + COGS + referrer cost)
    // Referrer commissions frozen onto patients registered in the period. A real
    // clinic cost, deducted from net profit (and gross margin) like operating expenses.
    referrerCost: number;
    unpaidBalance: number; // total outstanding tracked debt in USD (money owed) — current snapshot
    paymentsToday: number;
    // Payment-method split (USD) behind the collected-money figures, for the
    // click-to-open breakdown on the "amount collected" stat cards. `incomeByMethod`
    // mirrors `totalIncome` (windowed by the selected period); `paymentsTodayByMethod`
    // mirrors `paymentsToday` (today only). Each is redacted alongside its parent
    // total. Keyed by the RAW method value stored on each payment (an empty-string
    // key is the blank/"Other" bucket), so a retired method keeps its own label.
    incomeByMethod: Record<string, number>;
    paymentsTodayByMethod: Record<string, number>;
  };
  packagesSold: number;
  mostPopularPackage: string;
  todaysAppointments: Appointment[];
  recentPayments: Payment[];
  recentConsultations: RecentConsultation[];
  staffActivity: { name: string; role: Role; consults: number }[];
  incomeExpenseSeries: { month: string; income: number; expenses: number }[];
  packageRevenue: { name: string; revenue: number }[];
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
}
