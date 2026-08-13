import type {
  AuditLog as PAuditLog,
  ClientPackage as PClientPackage,
  Expense as PExpense,
  Package as PPackage,
  Product as PProduct,
  Referrer as PReferrer,
  ServicePrice as PServicePrice,
  SessionPlan as PSessionPlan,
  User as PUser,
} from "@prisma/client";
import { clinicDay } from "@/lib/config";
import { isTenderCurrency, type TenderCurrency } from "@/lib/money";
import type {
  AppointmentStatus,
  AuditEntry,
  ClientPackage,
  Currency,
  Expense,
  Package,
  PaymentMethod,
  Product,
  Referrer,
  Role,
  ServicePrice,
  ServicePriceKind,
  SessionPlan,
  StaffUser,
  VisitType,
} from "@/lib/types";

/** Date-only string (YYYY-MM-DD) for date fields rendered with formatDate. Uses
 * the clinic-timezone calendar day (not the UTC slice), so a stored timestamp maps
 * to the same day the app calls "today" — the two agree app-wide. */
export function dateOnly(date: Date | null | undefined): string | undefined {
  return date ? clinicDay(date) : undefined;
}

/** Full ISO timestamp for fields rendered with formatDateTime. */
function iso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

// These columns are stored as strings; the app layer owns the allowed values.
const asRole = (v: string) => v as Role;
export const asPaymentMethod = (v: string) => v as PaymentMethod;
/**
 * The denomination of an OBLIGATION (a price, a basket line, a debt). Only USD
 * and LBP are valid here — a bill is never denominated in a tender-only currency.
 * An unrecognised value throws rather than being reported as USD: silently
 * relabelling a currency is how a report starts lying about what it is summing.
 * The DB CHECK on ClientDebt.currency makes this unreachable for debts.
 */
export const asCurrency = (v: string): Currency => {
  if (v === "USD" || v === "LBP") return v;
  throw new Error(
    `Unsupported obligation currency "${v}" — the clinic bills in USD (LBP on legacy rows).`,
  );
};

/**
 * The currency money was TENDERED in (payments only). Fail-closed for the same
 * reason: this previously mapped anything that wasn't "LBP" to "USD", so a EUR
 * payment would have been reported to every client, dashboard and drill-down as
 * dollars. Backed by the `Payment_currency_supported` CHECK constraint.
 */
export const asTenderCurrency = (v: string): TenderCurrency => {
  if (isTenderCurrency(v)) return v;
  throw new Error(`Unsupported tender currency "${v}" on a payment — it cannot be valued.`);
};
export const asAppointmentStatus = (v: string) => v as AppointmentStatus;
export const asVisitType = (v: string) => v as VisitType;

export function toPackage(p: PPackage): Package {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    price: p.price,
    cost: p.cost,
    currency: asCurrency(p.currency),
    sessions: p.sessions,
    discountPercent: p.discountPercent,
    status: p.status as Package["status"],
    machine: p.machine ?? undefined,
  };
}

export function toClientPackage(cp: PClientPackage): ClientPackage {
  return {
    id: cp.id,
    packageName: cp.packageName,
    price: cp.price,
    currency: asCurrency(cp.currency),
    totalSessions: cp.totalSessions,
    usedSessions: cp.usedSessions,
    machine: cp.machine ?? undefined,
    startDate: dateOnly(cp.startDate)!,
    status: cp.status as ClientPackage["status"],
  };
}

export function toSessionPlan(p: PSessionPlan): SessionPlan {
  const credit = Math.max(0, p.sessionsPaid - p.sessionsUsed);
  return {
    id: p.id,
    clientId: p.clientId,
    machine: p.machine ?? undefined,
    unitPrice: p.unitPrice,
    currency: asCurrency(p.currency),
    usdToLbp: p.usdToLbp,
    sessionsNeeded: p.sessionsNeeded,
    sessionsUsed: p.sessionsUsed,
    sessionsPaid: p.sessionsPaid,
    status: p.status as SessionPlan["status"],
    credit,
    sessionsLeftToAttend: Math.max(0, p.sessionsNeeded - p.sessionsUsed),
    sessionsToPayFor: Math.max(0, p.sessionsNeeded - p.sessionsPaid),
    createdAt: dateOnly(p.createdAt)!,
  };
}

export function toExpense(e: PExpense): Expense {
  return {
    id: e.id,
    title: e.title,
    amount: e.amount,
    currency: asCurrency(e.currency),
    usdToLbp: e.usdToLbp,
    date: dateOnly(e.date)!,
    paidBy: e.paidBy ?? "",
    method: asPaymentMethod(e.method ?? "cash"),
    notes: e.notes ?? undefined,
    amountEdited: e.amountEdited,
  };
}

export function toProduct(p: PProduct): Product {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    cost: p.cost,
    currency: asCurrency(p.currency),
    active: p.active,
    stock: p.stock,
    lowStockThreshold: p.lowStockThreshold,
  };
}

// Body-part presets keep a three-way meaning, so null and "[]" must stay
// distinct: null → undefined (free-text entry), "[]" → [] (no body-part field),
// ["Abdomen", …] → fixed checklist.
function parseBodyParts(json: string | null): string[] | undefined {
  if (json == null) return undefined;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : undefined;
  } catch {
    return undefined;
  }
}

export function toReferrer(r: PReferrer): Referrer {
  return { id: r.id, name: r.name, active: r.active, fee: r.fee };
}

export function toServicePrice(p: PServicePrice): ServicePrice {
  return {
    id: p.id,
    kind: p.kind as ServicePriceKind,
    key: p.key,
    name: p.name,
    price: p.price,
    cost: p.cost,
    currency: asCurrency(p.currency),
    active: p.active,
    bodyParts: parseBodyParts(p.bodyParts),
  };
}

/**
 * Strips the admin-only `cost` field from a catalog row. Applied in the list
 * endpoints so a secretary/dietitian's browser never receives the owner's
 * cost/margin figures, even though they read the same catalog for prices.
 */
export function withoutCost<T extends { cost?: number }>(row: T): Omit<T, "cost"> {
  const { cost: _cost, ...rest } = row;
  void _cost;
  return rest;
}

/** Tolerant parse of a JSON-encoded string[] column (e.g. a user's supplements). */
function parseStringList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function toStaff(u: PUser): StaffUser {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone ?? undefined,
    role: asRole(u.role),
    status: u.status as StaffUser["status"],
    supplements: parseStringList(u.supplements),
    consultationFee: u.consultationFee ?? undefined,
    createdAt: dateOnly(u.createdAt)!,
    lastLoginAt: iso(u.lastLoginAt),
  };
}

export function toAudit(a: PAuditLog): AuditEntry {
  return {
    id: a.id,
    user: a.userName,
    action: a.action,
    entityType: a.entityType,
    entityLabel: a.entityLabel.replace(/^\[expense:[^\]]+\]\s*/, ""),
    timestamp: iso(a.createdAt)!,
  };
}
