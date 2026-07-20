import { db } from "../db";
import { toAudit, toExpense } from "../serialize";
import { getUsdToLbp } from "./settings";
import { userIdByEmail } from "./staff";
import { NotFoundError } from "../http";
import type { AuditEntry, Expense } from "@/lib/types";

type ExpenseActor = {
  name: string;
  email?: string;
};

type ExpenseInput = {
  title: string;
  amount: number;
  currency?: string;
  date?: string;
  paidBy?: string;
  method?: string;
  notes?: string;
};

// F8: fields an edit is allowed to change — the DATE is deliberately absent, so an
// expense can never be shifted into another reporting period after it's created.
type ExpenseEdit = Omit<ExpenseInput, "date">;

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function moneyLabel(amount: number, currency: string | null | undefined) {
  return `${currency === "LBP" ? "LBP" : "USD"} ${numberFormatter.format(amount)}`;
}

function valueLabel(value: string | null | undefined) {
  return value && value.trim() ? value.trim() : "empty";
}

function trimOptional(value: string | undefined) {
  return value?.trim() || null;
}

function auditPrefix(expenseId: string) {
  return `[expense:${expenseId}]`;
}

function auditLabel(expenseId: string, label: string) {
  return `${auditPrefix(expenseId)} ${label}`;
}

function stripAuditPrefix(label: string) {
  return label.replace(/^\[expense:[^\]]+\]\s*/, "");
}

export async function listExpenses(): Promise<Expense[]> {
  // F8/L3: the "Altered" badge is now driven by the reliable `amountEdited` column
  // (set on update) that toExpense reads — no more scanning audit-log text for the
  // word "Amount", which broke silently if the wording ever changed.
  const rows = await db.expense.findMany({ orderBy: { date: "desc" } });
  return rows.map(toExpense);
}

export async function createExpense(
  input: ExpenseInput & { createdById?: string | null },
  actor?: ExpenseActor,
): Promise<Expense> {
  const userId = input.createdById ?? (await userIdByEmail(actor?.email));
  const row = await db.expense.create({
    data: {
      title: input.title.trim(),
      amount: input.amount,
      currency: input.currency ?? "USD",
      usdToLbp: await getUsdToLbp(), // freeze the live rate onto the record
      date: input.date ? new Date(input.date) : new Date(),
      paidBy: trimOptional(input.paidBy),
      method: input.method,
      notes: trimOptional(input.notes),
      createdById: userId,
    },
  });
  await db.auditLog.create({
    data: {
      userId,
      userName: actor?.name ?? "Unknown user",
      action: "Created expense",
      entityType: "Expense",
      entityLabel: auditLabel(row.id, `${row.title}: ${moneyLabel(row.amount, row.currency)}`),
    },
  });
  return toExpense(row);
}

export async function updateExpense(
  id: string,
  input: ExpenseEdit,
  actor?: ExpenseActor,
): Promise<Expense> {
  const userId = await userIdByEmail(actor?.email);
  const row = await db.$transaction(async (tx) => {
    const before = await tx.expense.findUnique({ where: { id } });
    if (!before) throw new NotFoundError("Expense not found");

    // F8: the recorded date is intentionally NOT part of `next` — it can never be
    // changed after creation, so which period an expense counts toward is fixed.
    const next = {
      title: input.title.trim(),
      amount: input.amount,
      currency: input.currency ?? "USD",
      paidBy: trimOptional(input.paidBy),
      method: input.method,
      notes: trimOptional(input.notes),
    };

    const amountChanged = before.amount !== next.amount || before.currency !== next.currency;

    const changes: string[] = [];
    if (before.title !== next.title) changes.push(`Title: "${before.title}" -> "${next.title}"`);
    // F8: an amount edit always records the before → after values and who did it.
    if (amountChanged) {
      changes.push(`Amount: ${moneyLabel(before.amount, before.currency)} -> ${moneyLabel(next.amount, next.currency)}`);
    }
    if ((before.method ?? "") !== (next.method ?? "")) {
      changes.push(`Method: ${valueLabel(before.method)} -> ${valueLabel(next.method)}`);
    }
    if ((before.paidBy ?? "") !== (next.paidBy ?? "")) {
      changes.push(`Paid by: ${valueLabel(before.paidBy)} -> ${valueLabel(next.paidBy)}`);
    }
    if ((before.notes ?? "") !== (next.notes ?? "")) {
      changes.push(`Notes: "${valueLabel(before.notes)}" -> "${valueLabel(next.notes)}"`);
    }

    const updated = await tx.expense.update({
      where: { id },
      data: {
        ...next,
        // F8/L3: reliable flag for the admin "Altered" badge. Once the amount has
        // ever been edited it stays flagged, independent of audit-log wording.
        amountEdited: before.amountEdited || amountChanged,
      },
    });

    if (changes.length > 0) {
      await tx.auditLog.create({
        data: {
          userId,
          userName: actor?.name ?? "Unknown user",
          action: "Updated expense",
          entityType: "Expense",
          entityLabel: auditLabel(before.id, `${before.title}: ${changes.join("; ")}`),
        },
      });
    }

    return updated;
  });

  return toExpense(row);
}

export async function listExpenseAudit(expenseId: string): Promise<AuditEntry[]> {
  const expense = await db.expense.findUnique({ where: { id: expenseId } });
  if (!expense) throw new NotFoundError("Expense not found");

  const prefix = auditPrefix(expenseId);
  const rows = await db.auditLog.findMany({
    where: {
      entityType: "Expense",
      OR: [
        { entityLabel: { startsWith: prefix } },
        // Backward compatibility for expense logs created before id tagging.
        { entityLabel: { startsWith: `${expense.title}:` } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    ...toAudit(row),
    entityLabel: stripAuditPrefix(row.entityLabel),
  }));
}
