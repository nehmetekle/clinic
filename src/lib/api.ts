import type {
  Appointment,
  AppointmentStatus,
  AuditEntry,
  BloodSample,
  BloodSampleFile,
  ClientBloodFile,
  ClientConsultationFile,
  ConsultationFile,
  Client,
  ClientDebt,
  ClientDetail,
  ClinicSettings,
  ConsultationListItem,
  Consultation,
  ConsultationStatus,
  DashboardSummary,
  Expense,
  MedicalHistory,
  Package,
  Payment,
  PaymentMethod,
  Product,
  Referrer,
  Role,
  ServicePrice,
  SessionPlan,
  StaffUser,
  VisitBasket,
  VisitBasketStatus,
} from "./types";
import type {
  CreateAppointmentInput,
  CreateClientInput,
  CreateConsultationInput,
  CreateExpenseInput,
  CreatePackageInput,
  CreatePaymentInput,
  CreateProductInput,
  CreateReferrerInput,
  CreateServicePriceInput,
  CreateSessionPlanInput,
  CreateStaffInput,
  UpdateStaffInput,
  MedicalHistoryInput,
  SettleVisitBasketInput,
  UpdateBloodSampleInput,
  UpdateClientInput,
  UpdateExpenseInput,
  UpdateProductInput,
  UpdateReferrerInput,
  UpdateServicePriceInput,
  UpdateVisitBasketInput,
} from "./validation";

// Identity now rides along automatically via the httpOnly session cookie on
// every same-origin fetch — nothing to attach client-side any more. This
// marker header is a CSRF guard for mutations: a cross-site page can trigger
// a same-cookie request but (with no CORS policy configured on this app)
// can't set a custom header without a preflight that's never approved.
// middleware.ts rejects any non-GET /api/* request missing it.
const CSRF_HEADER = { "x-nutriclinic-fetch": "1" } as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/** Shape of the JSON error envelope returned by `handleError` on the server. */
type ApiErrorBody = {
  error?: string;
  code?: string;
  matches?: Client[];
  details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
};

/**
 * Thrown by {@link api.createClient} when the phone matches existing patient(s)
 * and the duplicate wasn't confirmed. Carries the matches so the form can warn
 * "already a client" and let staff proceed (resubmit with confirmDuplicatePhone).
 */
export class DuplicatePhoneError extends Error {
  matches: Client[];
  constructor(matches: Client[]) {
    super("A patient with this phone number already exists.");
    this.name = "DuplicatePhoneError";
    this.matches = matches;
  }
}

/**
 * Turns an error response body into a human-readable message. For Zod failures
 * the server sends a generic `"Validation failed"` plus per-field details; we
 * surface the first specific message (e.g. the weekend rule) so the toast says
 * *what* is wrong instead of a bare "Validation failed".
 */
function apiErrorMessage(err: ApiErrorBody | null, status: number): string {
  const fieldFirst = err?.details?.fieldErrors
    ? Object.values(err.details.fieldErrors).flat().find(Boolean)
    : undefined;
  const specific = err?.details?.formErrors?.[0] ?? fieldFirst;
  return specific ?? err?.error ?? `Request failed (${status})`;
}

async function sendJson<T>(method: "POST" | "PATCH" | "PUT", url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...CSRF_HEADER },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err: ApiErrorBody | null = await res.json().catch(() => null);
    // Duplicate-phone conflicts carry the matching patient(s) so the caller can
    // warn and offer "register anyway" — surface them as a typed error.
    if (res.status === 409 && err?.code === "duplicate_phone") {
      throw new DuplicatePhoneError(err.matches ?? []);
    }
    throw new Error(apiErrorMessage(err, res.status));
  }
  return res.json();
}

const postJson = <T>(url: string, body: unknown) => sendJson<T>("POST", url, body);
const patchJson = <T>(url: string, body: unknown) => sendJson<T>("PATCH", url, body);
const putJson = <T>(url: string, body: unknown) => sendJson<T>("PUT", url, body);

/**
 * Multipart POST for a single file upload. The browser sets the multipart
 * Content-Type (with boundary) itself, so we only attach the CSRF marker header —
 * setting Content-Type by hand would break the boundary.
 */
async function postForm<T>(url: string, file: File): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(url, { method: "POST", headers: CSRF_HEADER, body });
  if (!res.ok) {
    const err: ApiErrorBody | null = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(err, res.status));
  }
  return res.json();
}

async function deleteJson(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", headers: CSRF_HEADER });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(err, res.status));
  }
}

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  email: string;
  totpEnabled: boolean;
}

export type LoginResult = { user: AuthUser } | { requires2FA: true; pendingToken: string };

export const api = {
  login: (body: { email: string; password: string }) =>
    postJson<LoginResult>("/api/auth/login", body),
  verifyTwoFactor: (body: { pendingToken: string; code: string }) =>
    postJson<{ user: AuthUser }>("/api/auth/verify-2fa", body),
  logout: () => postJson<{ ok: true }>("/api/auth/logout", {}),
  me: () => getJson<{ user: AuthUser | null }>("/api/auth/me"),

  setupTwoFactor: () => postJson<{ secret: string; qrCodeDataUrl: string }>("/api/auth/2fa/setup", {}),
  confirmTwoFactor: (code: string) =>
    postJson<{ backupCodes: string[] }>("/api/auth/2fa/confirm", { code }),
  disableTwoFactor: (password: string) =>
    postJson<{ ok: true }>("/api/auth/2fa/disable", { password }),
  resetStaffPassword: (id: string, password: string) =>
    patchJson<StaffUser>(`/api/staff/${id}/password`, { password }),
  sendTestReminder: (phone: string) =>
    postJson<{ ok: true; id?: string }>("/api/reminders/test", { phone }),

  listClients: () => getJson<Client[]>("/api/clients"),
  searchClients: (q: string) => getJson<Client[]>(`/api/clients?q=${encodeURIComponent(q)}`),
  // Existing patients whose phone matches (normalized) — drives the duplicate warning.
  findClientsByPhone: (phone: string) =>
    getJson<Client[]>(`/api/clients/by-phone?phone=${encodeURIComponent(phone)}`),
  getClient: (id: string) => getJson<ClientDetail>(`/api/clients/${id}`),
  createClient: (body: CreateClientInput) => postJson<Client>("/api/clients", body),
  updateClient: (id: string, body: UpdateClientInput) =>
    patchJson<Client>(`/api/clients/${id}`, body),
  getMedicalHistory: (id: string) =>
    getJson<MedicalHistory | null>(`/api/clients/${id}/medical-history`),
  saveMedicalHistory: (id: string, body: MedicalHistoryInput) =>
    putJson<MedicalHistory>(`/api/clients/${id}/medical-history`, body),

  listPackages: () => getJson<Package[]>("/api/packages"),
  createPackage: (body: CreatePackageInput) => postJson<Package>("/api/packages", body),
  setPackageStatus: (id: string, status: "active" | "inactive") =>
    patchJson<Package>(`/api/packages/${id}`, { status }),

  listAppointments: () => getJson<Appointment[]>("/api/appointments"),
  createAppointment: (body: CreateAppointmentInput) =>
    postJson<Appointment>("/api/appointments", body),
  setAppointmentStatus: (id: string, status: AppointmentStatus) =>
    patchJson<Appointment>(`/api/appointments/${id}`, { status }),
  // Check-in with the confirmed doctor: flips status to checked_in and binds the
  // visit to that doctor in one write, so the patient lands in only their queue.
  checkInAppointment: (id: string, dietitianId: string | null) =>
    patchJson<Appointment>(`/api/appointments/${id}`, { status: "checked_in", dietitianId }),

  listConsultations: (filter?: {
    clientId?: string;
    status?: ConsultationStatus;
    date?: string;
  }) => {
    const params = new URLSearchParams();
    if (filter?.clientId) params.set("clientId", filter.clientId);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.date) params.set("date", filter.date);
    const qs = params.toString();
    return getJson<ConsultationListItem[]>(`/api/consultations${qs ? `?${qs}` : ""}`);
  },
  createConsultation: (body: CreateConsultationInput) =>
    postJson<Consultation>("/api/consultations", body),
  // Edit an open (in-progress) consultation; pass close:true in the body to finalize.
  updateConsultation: (id: string, body: CreateConsultationInput) =>
    patchJson<Consultation>(`/api/consultations/${id}`, body),
  // Delete an open consultation opened by mistake (dietitian on own visit, or admin).
  deleteConsultation: (id: string) => deleteJson(`/api/consultations/${id}`),

  // Pass a clinic-day (YYYY-MM-DD) to fetch only that day's payments; omit for all.
  listPayments: (date?: string) =>
    getJson<Payment[]>(`/api/payments${date ? `?date=${date}` : ""}`),
  createPayment: (body: CreatePaymentInput) => postJson<Payment>("/api/payments", body),

  // Tracked client debts (money owed but not collected). Cleared = collected now
  // (records a Payment); voided = written off.
  listOutstandingDebts: () => getJson<ClientDebt[]>("/api/client-debts"),
  clearClientDebt: (id: string, body: { method: PaymentMethod; notes?: string }) =>
    patchJson<ClientDebt>(`/api/client-debts/${id}`, { action: "clear", ...body }),
  voidClientDebt: (id: string, body: { reason: string }) =>
    patchJson<ClientDebt>(`/api/client-debts/${id}`, { action: "void", ...body }),

  listVisitBaskets: (status?: VisitBasketStatus) =>
    getJson<VisitBasket[]>(`/api/visit-baskets${status ? `?status=${status}` : ""}`),
  updateVisitBasket: (id: string, body: UpdateVisitBasketInput) =>
    patchJson<VisitBasket>(`/api/visit-baskets/${id}`, body),
  settleVisitBasket: (id: string, body: SettleVisitBasketInput) =>
    postJson<VisitBasket>(`/api/visit-baskets/${id}/settle`, body),

  listBloodSamples: (clientId?: string) =>
    getJson<BloodSample[]>(`/api/blood-samples${clientId ? `?clientId=${clientId}` : ""}`),
  updateBloodSample: (id: string, body: UpdateBloodSampleInput) =>
    patchJson<BloodSample>(`/api/blood-samples/${id}`, body),

  // Files attached to a specific blood test (lab-result PDFs / scans).
  listBloodSampleFiles: (sampleId: string) =>
    getJson<BloodSampleFile[]>(`/api/blood-samples/${sampleId}/files`),
  uploadBloodSampleFile: (sampleId: string, file: File) =>
    postForm<BloodSampleFile>(`/api/blood-samples/${sampleId}/files`, file),
  deleteBloodSampleFile: (fileId: string) => deleteJson(`/api/blood-sample-files/${fileId}`),
  // Direct URL for an <a href> download (GET rides the session cookie; no CSRF
  // header needed on GET). Content is served doctor/admin-only server-side.
  bloodSampleFileUrl: (fileId: string) => `/api/blood-sample-files/${fileId}`,
  // Every blood-test file for a patient (client profile Files tab).
  listClientBloodFiles: (clientId: string) =>
    getJson<ClientBloodFile[]>(`/api/clients/${clientId}/blood-files`),

  // Render the visit's Food List to PDF and attach it to the consultation,
  // replacing any copy generated earlier. Doctor/admin only.
  generateFoodListPdf: (consultationId: string) =>
    postJson<ConsultationFile>(`/api/consultations/${consultationId}/food-list-pdf`, {}),
  // Direct URL for an <a href> download. Unlike a blood-test result, the finished
  // Food List PDF is downloadable by every role.
  consultationFileUrl: (fileId: string) => `/api/consultation-files/${fileId}`,
  // Every consultation-generated document for a patient (client profile Files tab).
  listClientConsultationFiles: (clientId: string) =>
    getJson<ClientConsultationFile[]>(`/api/clients/${clientId}/consultation-files`),

  listExpenses: () => getJson<Expense[]>("/api/expenses"),
  createExpense: (body: CreateExpenseInput) => postJson<Expense>("/api/expenses", body),
  updateExpense: (id: string, body: UpdateExpenseInput) =>
    patchJson<Expense>(`/api/expenses/${id}`, body),
  listExpenseAudit: (id: string) => getJson<AuditEntry[]>(`/api/expenses/${id}/audit`),

  listStaff: () => getJson<StaffUser[]>("/api/staff"),
  createStaff: (body: CreateStaffInput) => postJson<StaffUser>("/api/staff", body),
  updateStaff: (id: string, body: UpdateStaffInput) =>
    patchJson<StaffUser>(`/api/staff/${id}`, body),
  setStaffStatus: (id: string, status: "active" | "inactive") =>
    patchJson<StaffUser>(`/api/staff/${id}`, { status }),
  updateStaffSupplements: (id: string, supplements: string[]) =>
    putJson<StaffUser>(`/api/staff/${id}/supplements`, { supplements }),
  // Admin sets a dietitian's consultation fee (USD); 0 clears it.
  setConsultationFee: (id: string, consultationFee: number) =>
    putJson<StaffUser>(`/api/staff/${id}/consultation-fee`, { consultationFee }),

  // Pay-as-you-go session plans (separate from fixed-price packages). Plans are
  // read via the client-detail payload; this creates a new one during a visit.
  createSessionPlan: (body: CreateSessionPlanInput) =>
    postJson<SessionPlan>("/api/session-plans", body),

  listAudit: () => getJson<AuditEntry[]>("/api/audit"),
  // `range` scopes the flow figures (income, expenses, net profit) to [from, to];
  // omit it for all-time. Snapshot figures ignore it.
  getDashboard: (range?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (range?.from) q.set("from", range.from);
    if (range?.to) q.set("to", range.to);
    const qs = q.toString();
    return getJson<DashboardSummary>(`/api/dashboard${qs ? `?${qs}` : ""}`);
  },

  getSettings: () => getJson<ClinicSettings>("/api/settings"),
  updateSettings: (body: { usdToLbp?: number; usdToEur?: number }) =>
    putJson<ClinicSettings>("/api/settings", body),

  listProducts: () => getJson<Product[]>("/api/products"),
  createProduct: (body: CreateProductInput) => postJson<Product>("/api/products", body),
  updateProduct: (id: string, body: UpdateProductInput) =>
    putJson<Product>(`/api/products/${id}`, body),
  deleteProduct: (id: string) => deleteJson(`/api/products/${id}`),

  listReferrers: () => getJson<Referrer[]>("/api/referrers"),
  createReferrer: (body: CreateReferrerInput) => postJson<Referrer>("/api/referrers", body),
  updateReferrer: (id: string, body: UpdateReferrerInput) =>
    putJson<Referrer>(`/api/referrers/${id}`, body),
  deleteReferrer: (id: string) => deleteJson(`/api/referrers/${id}`),

  listServicePrices: () => getJson<ServicePrice[]>("/api/service-prices"),
  createServicePrice: (body: CreateServicePriceInput) =>
    postJson<ServicePrice>("/api/service-prices", body),
  updateServicePrice: (id: string, body: UpdateServicePriceInput) =>
    putJson<ServicePrice>(`/api/service-prices/${id}`, body),
};
