import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, DuplicatePhoneError, ForbiddenError, NotFoundError } from "../http";
import { dateOnly, toClientPackage } from "../serialize";
import { expirePastScheduledAppointments, toAppointment } from "./appointments";
import { listClientDebts } from "./clientDebts";
import { resolveReferralFee } from "./referrers";
import { consultationInclude, toConsultation } from "./consultations";
import { paymentInclude, toPayment } from "./payments";
import { listSessionPlans } from "./sessionPlans";
import { getUsdToLbp } from "./settings";
import { toUsdFrozen } from "@/lib/config";
import type { Client, ClientDetail, Role } from "@/lib/types";

/**
 * Parse a date-of-birth string into a Date, or null when empty. Throws on an
 * unparseable value (e.g. a mistyped 5-digit year) so it surfaces as a clean
 * validation error rather than an Invalid Date that crashes Prisma with a 500.
 */
function parseDateOfBirth(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ConflictError(`Invalid date of birth: "${value}".`);
  }
  return d;
}

const listInclude = {
  packages: { orderBy: { createdAt: "desc" } },
  sessionPlans: true,
  assignedDietitian: true,
  medicalHistory: { select: { id: true } },
  // Most recent visit, for the "Inactive" (>1 year since last visit) label.
  consultations: { orderBy: { date: "desc" }, take: 1, select: { date: true } },
} satisfies Prisma.ClientInclude;

type ClientRow = Prisma.ClientGetPayload<{ include: typeof listInclude }>;

/**
 * A patient is "active" while they still have treatment sessions to finish — an
 * active bundle or session plan with sessions remaining. Purely derived; there is
 * no stored patient status.
 */
function isActive(c: ClientRow): boolean {
  const bundleLeft = c.packages.some(
    (p) => p.status === "active" && p.usedSessions < p.totalSessions,
  );
  const planLeft = c.sessionPlans.some(
    (p) => p.status === "active" && p.sessionsUsed < p.sessionsNeeded,
  );
  return bundleLeft || planLeft;
}

/**
 * A client is "inactive" once their most recent visit is more than a year old —
 * a distinct axis from `active` (which tracks remaining sessions). Clients with
 * no visit yet are not labelled inactive. The UI shows "Active" in preference
 * when both apply.
 */
function isInactive(c: ClientRow): boolean {
  const last = c.consultations[0]?.date;
  if (!last) return false;
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  return last < oneYearAgo;
}

/** Strips spaces and punctuation so "+961 70 000 000" and "+96170000000" compare equal. */
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-().]/g, "");
}

/**
 * A client is "intake complete" once every field the check-in flow requires is
 * present. Registration only captures name + phone, so a bare registration is
 * intake-incomplete until check-in fills the rest. Mirrors the gate in
 * src/app/(app)/clients/[id]/checkin/page.tsx.
 */
function deriveIntakeComplete(input: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  country?: string;
  referralSource?: string;
}): boolean {
  return Boolean(
    input.firstName?.trim() &&
      input.lastName?.trim() &&
      input.phone?.trim() &&
      input.dateOfBirth &&
      input.gender &&
      input.country?.trim() &&
      input.referralSource?.trim(),
  );
}

function toClient(c: ClientRow): Client {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    email: c.email ?? undefined,
    dateOfBirth: dateOnly(c.dateOfBirth),
    gender: (c.gender ?? undefined) as Client["gender"],
    address: c.address ?? undefined,
    emergencyContact: c.emergencyContact ?? undefined,
    medicalNotes: c.medicalNotes ?? undefined,
    allergies: c.allergies ?? undefined,
    passportNumber: c.passportNumber ?? undefined,
    country: c.country ?? undefined,
    maritalStatus: (c.maritalStatus ?? undefined) as Client["maritalStatus"],
    referralSource: c.referralSource ?? undefined,
    firstTimePatient: c.firstTimePatient,
    hasMedicalHistory: c.medicalHistory != null,
    active: isActive(c),
    inactive: isInactive(c),
    intakeComplete: c.intakeComplete,
    assignedDietitian: c.assignedDietitian?.fullName,
    assignedDietitianId: c.assignedDietitian?.id,
    registeredAt: dateOnly(c.registeredAt)!,
    packages: c.packages.map(toClientPackage),
  };
}

export async function listClients(
  opts: { q?: string; includeClinical?: boolean } = {},
): Promise<Client[]> {
  const { q, includeClinical = true } = opts;
  const rows = await db.client.findMany({
    include: listInclude,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  let clients = rows.map(toClient);

  // Search by name, email or phone (case-insensitive; phone matched on digits only
  // so "+961 70" and "96170" both work). Done in JS since SQLite has no insensitive filter.
  const term = q?.trim().toLowerCase();
  if (term) {
    const digits = term.replace(/\D/g, "");
    clients = clients.filter((c) => {
      const name = `${c.firstName} ${c.lastName}`.toLowerCase();
      const email = (c.email ?? "").toLowerCase();
      const phone = c.phone.replace(/\D/g, "");
      return name.includes(term) || email.includes(term) || (digits !== "" && phone.includes(digits));
    });
  }

  // Hide clinical fields from non-clinical roles, same as getClientDetail.
  if (!includeClinical) {
    clients = clients.map((c) => ({ ...c, medicalNotes: undefined, allergies: undefined }));
  }
  return clients;
}

/**
 * Every client whose phone matches `phone` under {@link normalizePhone} (spacing
 * and punctuation ignored). This is the single source of truth for the duplicate-
 * patient warning shown at registration and phone booking — an exact normalized
 * match, not the substring/digit search `listClients` uses, so it doesn't over-warn.
 * Returns [] for a blank phone. Clinical fields are dropped when `includeClinical`
 * is false so the warning never leaks medical notes to the front desk.
 */
export async function findClientsByPhone(
  phone: string,
  includeClinical = true,
): Promise<Client[]> {
  const norm = normalizePhone(phone);
  if (norm === "") return [];
  const rows = await db.client.findMany({
    include: listInclude,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return rows
    .filter((r) => normalizePhone(r.phone) === norm)
    .map((r) => {
      const c = toClient(r);
      return includeClinical ? c : { ...c, medicalNotes: undefined, allergies: undefined };
    });
}

export async function getClientDetail(
  id: string,
  includeClinical = true,
  role?: Role | null,
): Promise<ClientDetail | null> {
  const client = await db.client.findUnique({ where: { id }, include: listInclude });
  if (!client) return null;

  // Resolve any stale bookings before reading this client's appointment history,
  // so a past no-show never lingers as "Scheduled" on the profile. See the sweep's
  // definition in the appointments repository for the rationale.
  await expirePastScheduledAppointments();

  const [appointments, consultations, payments, sessionPlans, debts, currentRate] =
    await Promise.all([
      db.appointment.findMany({
        where: { clientId: id },
        include: {
          client: { include: { medicalHistory: { select: { id: true } } } },
          dietitian: true,
        },
        orderBy: [{ date: "asc" }, { time: "asc" }],
      }),
      db.consultation.findMany({
        where: { clientId: id },
        include: consultationInclude,
        orderBy: { visitNumber: "asc" },
      }),
      db.payment.findMany({
        where: { clientId: id },
        include: paymentInclude,
        orderBy: { date: "desc" },
      }),
      // Pay-as-you-go session plans (separate from packages).
      listSessionPlans(id),
      // Tracked debts (owed but not collected) — separate from the payment balance.
      listClientDebts(id),
      getUsdToLbp(),
    ]);

  // Outstanding tracked debts in USD (frozen-rate summed). Tracked debts are the
  // single source of truth for what a patient owes — recorded explicitly when a
  // visit closes unpaid or the secretary logs an override at settlement. There is
  // no payment-based "charged minus paid" balance.
  const debtTotal = debts
    .filter((d) => d.status === "outstanding")
    .reduce((sum, d) => sum + toUsdFrozen(d.amount, d.currency, d.usdToLbp, currentRate), 0);

  const mapped = toClient(client);
  // Non-clinical roles (secretary) get contact + visit/package + payment data,
  // but no medical notes/allergies and no consultation records (weight, BMI,
  // measurements, clinical notes). Enforced here so the data never leaves the server.
  let clientView = includeClinical
    ? mapped
    : { ...mapped, medicalNotes: undefined, allergies: undefined };

  // A plain doctor (dietitian, not admin) only needs a narrow slice of the
  // personal record — name, gender, referrer, age (dateOfBirth) and first-time
  // status. Drop the rest here so it never leaves the server, matching the
  // narrowed Personal tab in the client profile UI.
  if (role === "dietitian") {
    clientView = {
      ...clientView,
      phone: "",
      email: undefined,
      address: undefined,
      emergencyContact: undefined,
      passportNumber: undefined,
      country: undefined,
      maritalStatus: undefined,
    };
  }

  return {
    client: clientView,
    appointments: appointments.map((appointment) =>
      toAppointment(appointment, { includeMedicalHistoryStatus: includeClinical }),
    ),
    consultations: includeClinical ? consultations.map(toConsultation) : [],
    payments: payments.map(toPayment),
    sessionPlans,
    debts,
    debtTotal,
  };
}

export async function createClient(input: {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  emergencyContact?: string;
  medicalNotes?: string;
  allergies?: string;
  passportNumber?: string;
  country?: string;
  maritalStatus?: string;
  referralSource?: string;
  firstTimePatient?: boolean;
  intakeComplete?: boolean;
  assignedDietitianId?: string | null;
  // Set once the caller has seen the duplicate-phone warning and means to add a
  // second patient on the same line anyway (e.g. a family member).
  confirmDuplicatePhone?: boolean;
}): Promise<Client> {
  // Registration captures the patient's details only. Packages/bundles are never
  // assigned here — the dietitian starts a treatment-scoped bundle during a visit.

  // Warn-don't-block duplicate guard: two patients may legitimately share a phone
  // (family), so a match is surfaced to the caller — never rejected — unless they
  // confirmed the duplicate. Name is intentionally NOT a uniqueness criterion.
  // Clinical fields are stripped from the returned matches (the warning only needs
  // identity). This is the server-side safety net behind the forms' inline warning.
  if (!input.confirmDuplicatePhone) {
    const matches = await findClientsByPhone(input.phone, false);
    if (matches.length > 0) throw new DuplicatePhoneError(matches);
  }

  // Freeze the referrer's commission onto the patient at THIS registration moment —
  // whether it's the full new-client form or a phone booking, both capture the
  // referrer here. A one-time fee, snapshotted from the referrer's LIVE rate at
  // registration so a later rate change never re-prices this patient. null when
  // self-referred or the referrer has no fee at registration.
  const referralFee = await resolveReferralFee(input.referralSource);

  const created = await db.client.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      dateOfBirth: parseDateOfBirth(input.dateOfBirth),
      gender: input.gender,
      address: input.address,
      emergencyContact: input.emergencyContact,
      medicalNotes: input.medicalNotes,
      allergies: input.allergies,
      passportNumber: input.passportNumber,
      country: input.country,
      maritalStatus: input.maritalStatus,
      referralSource: input.referralSource,
      referralFee,
      firstTimePatient: input.firstTimePatient ?? false,
      intakeComplete: input.intakeComplete ?? deriveIntakeComplete(input),
      assignedDietitianId: input.assignedDietitianId ?? null,
    },
  });

  const row = await db.client.findUniqueOrThrow({
    where: { id: created.id },
    include: listInclude,
  });
  return toClient(row);
}

// Clinical fields on the patient record — the dietitian's (and admin's) domain,
// mirroring canViewClinical. Everything else on the record (demographics,
// contact details, referrer, assigned dietitian) is front-desk data.
const CLINICAL_FIELDS: readonly string[] = ["medicalNotes", "allergies"];

/**
 * Post-check-in edit rights mirror who owns each field at intake: the front
 * desk (secretary, admin) fills demographics/contact at check-in and keeps
 * edit rights afterwards; clinical notes stay with the dietitian (and admin).
 * Until intake is complete, any signed-in role may fill gaps — completing the
 * record IS the check-in flow (the dietitian can run it from their dashboard).
 */
function assertCanEditClientFields(
  role: Role,
  input: Record<string, unknown>,
): void {
  const supplied = Object.keys(input).filter((k) => input[k] !== undefined);
  const clinical = supplied.some((k) => CLINICAL_FIELDS.includes(k));
  const frontDesk = supplied.some((k) => !CLINICAL_FIELDS.includes(k));
  if (clinical && !(role === "dietitian" || role === "admin")) {
    throw new ForbiddenError(
      "Medical notes and allergies can only be edited by the doctor or admin.",
    );
  }
  if (frontDesk && !(role === "secretary" || role === "admin")) {
    throw new ForbiddenError(
      "Patient details can only be edited by the front desk (secretary) or admin after check-in.",
    );
  }
}

export async function updateClient(
  id: string,
  input: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    dateOfBirth?: string;
    gender?: string;
    address?: string;
    emergencyContact?: string;
    medicalNotes?: string;
    allergies?: string;
    passportNumber?: string;
    country?: string;
    maritalStatus?: string;
    referralSource?: string;
    firstTimePatient?: boolean;
    intakeComplete?: boolean;
    assignedDietitianId?: string | null;
  },
  role: Role,
): Promise<Client> {
  const current = await db.client.findUnique({
    where: { id },
    select: { intakeComplete: true },
  });
  if (!current) throw new NotFoundError("Client not found");
  if (current.intakeComplete) assertCanEditClientFields(role, input);

  // Only forward keys that were actually supplied so a partial check-in update
  // never clears fields it didn't touch. dateOfBirth is mapped to a Date.
  const data: Prisma.ClientUpdateInput = {};
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email || null;
  if (input.dateOfBirth !== undefined)
    data.dateOfBirth = parseDateOfBirth(input.dateOfBirth);
  if (input.gender !== undefined) data.gender = input.gender || null;
  // Optional free-text fields: an explicit empty string clears the stored value
  // (the profile edit form sends "" when a field is erased).
  if (input.address !== undefined) data.address = input.address || null;
  if (input.emergencyContact !== undefined)
    data.emergencyContact = input.emergencyContact || null;
  if (input.medicalNotes !== undefined) data.medicalNotes = input.medicalNotes || null;
  if (input.allergies !== undefined) data.allergies = input.allergies || null;
  if (input.passportNumber !== undefined)
    data.passportNumber = input.passportNumber || null;
  if (input.country !== undefined) data.country = input.country || null;
  if (input.maritalStatus !== undefined) data.maritalStatus = input.maritalStatus || null;
  // referralFee is deliberately NOT (re)frozen here. The commission is snapshotted
  // once, at the registration moment (createClient) — which includes a phone
  // booking, since that captures the referrer too. Editing referralSource later is
  // a correction to the record, not a new registration, so it never re-prices the
  // frozen fee (nor retroactively attaches a rate the referrer only got afterwards).
  if (input.referralSource !== undefined) data.referralSource = input.referralSource;
  if (input.firstTimePatient !== undefined) data.firstTimePatient = input.firstTimePatient;
  if (input.intakeComplete !== undefined) data.intakeComplete = input.intakeComplete;
  if (input.assignedDietitianId !== undefined)
    data.assignedDietitian = input.assignedDietitianId
      ? { connect: { id: input.assignedDietitianId } }
      : { disconnect: true };

  const row = await db.client.update({
    where: { id },
    data,
    include: listInclude,
  });
  return toClient(row);
}
