import { Prisma } from "@prisma/client";
import { db } from "../db";
import { toAudit } from "../serialize";
import type { AuditEntry } from "@/lib/types";

export async function listAudit(): Promise<AuditEntry[]> {
  const rows = await db.auditLog.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toAudit);
}

const auditMoneyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Compact money label for audit entity labels, e.g. "USD 42" / "LBP 500". */
export function auditMoney(amount: number, currency: string | null | undefined): string {
  return `${currency === "LBP" ? "LBP" : "USD"} ${auditMoneyFmt.format(amount)}`;
}

/**
 * Writes one audit row on the given client (pass the surrounding transaction so
 * the entry commits — or rolls back — atomically with the change it records).
 * Mirrors the expense audit writes: a required actor name (falling back to
 * "Unknown user"), an optional userId link, and a human-readable entity label.
 */
export async function writeAudit(
  client: Prisma.TransactionClient,
  entry: {
    userId?: string | null;
    userName?: string | null;
    action: string;
    entityType: string;
    entityLabel: string;
  },
): Promise<void> {
  await client.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      userName: entry.userName ?? "Unknown user",
      action: entry.action,
      entityType: entry.entityType,
      entityLabel: entry.entityLabel,
    },
  });
}
