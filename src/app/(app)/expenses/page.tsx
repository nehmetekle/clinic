"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { FormRow, Input, MoneyInput, Select, Textarea } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useSession } from "@/lib/session";
import { CLINIC, todayIso, toUsdFrozen } from "@/lib/config";
import { cn, formatDate, formatDateTime, formatMoney, parseNumberInput } from "@/lib/utils";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES } from "@/lib/types";
import type { AuditEntry, Expense } from "@/lib/types";

// A fresh blank expense; `date` defaults to today, resolved each time so it never
// goes stale while the page stays open. `paidBy` defaults to the current user's
// name (whoever is logging the expense) but stays freely editable.
const emptyExpense = (paidBy = "") => ({ title: "", amount: "", currency: "USD", date: todayIso(), method: "cash", paidBy, notes: "" });

// Red outline for an empty required field — every field must be filled.
const missingClass = "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30";

// ---- Period filter (view expenses by month / week / day / range) ----
type PeriodMode = "month" | "week" | "day" | "range" | "all";

/** Monday–Sunday bounds (inclusive, YYYY-MM-DD) of the week containing `dateStr`. */
function weekBounds(dateStr: string): [string, string] {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  const diffToMon = (dt.getUTCDay() + 6) % 7; // days since Monday
  const start = new Date(dt);
  start.setUTCDate(dt.getUTCDate() - diffToMon);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

/** "June 2026" for a YYYY-MM key. */
function formatMonth(key: string): string {
  return new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function ExpensesPage() {
  const { toast } = useToast();
  const { user } = useSession();
  const { data, loading, error, refetch } = useApi(() => api.listExpenses());
  const settings = useApi(() => api.getSettings());
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyExpense());
  const [saving, setSaving] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditExpense, setAuditExpense] = useState<Expense | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const expenses = data ?? [];

  // Period filter — presets are anchored to today's real date.
  const today = todayIso();
  const [mode, setMode] = useState<PeriodMode>("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState(today);
  const [rangeFrom, setRangeFrom] = useState(`${today.slice(0, 7)}-01`);
  const [rangeTo, setRangeTo] = useState(today);

  const [weekStart, weekEnd] = weekBounds(day);
  function inPeriod(date: string) {
    switch (mode) {
      case "month": return date.startsWith(month);
      case "week": return date >= weekStart && date <= weekEnd;
      case "day": return date === day;
      case "range": return (!rangeFrom || date >= rangeFrom) && (!rangeTo || date <= rangeTo);
      default: return true;
    }
  }
  const periodLabel =
    mode === "month" ? formatMonth(month)
    : mode === "week" ? `${formatDate(weekStart)} – ${formatDate(weekEnd)}`
    : mode === "day" ? formatDate(day)
    : mode === "range" ? `${formatDate(rangeFrom)} – ${formatDate(rangeTo)}`
    : "All time";

  const filtered = expenses.filter((e) => inPeriod(e.date));
  // USD is the single source of truth: LBP expenses fold into the same USD total
  // at the rate frozen on each record when it was logged (not today's rate).
  const fallbackRate = settings.data?.usdToLbp ?? CLINIC.defaultUsdToLbp;
  const totalUSD = filtered.reduce(
    (s, e) => s + toUsdFrozen(e.amount, e.currency, e.usdToLbp, fallbackRate),
    0,
  );

  // Every field is required.
  const canSave =
    form.title.trim() !== "" &&
    form.amount.trim() !== "" &&
    parseNumberInput(form.amount) > 0 &&
    form.date !== "" &&
    form.method !== "" &&
    form.notes.trim() !== "";

  function openAdd() {
    setEditingId(null);
    setForm(emptyExpense(user?.name ?? ""));
    setOpen(true);
  }

  function openEdit(expense: (typeof expenses)[number]) {
    setEditingId(expense.id);
    setForm({
      title: expense.title,
      amount: String(expense.amount),
      currency: expense.currency,
      date: expense.date,
      method: expense.method,
      paidBy: expense.paidBy,
      notes: expense.notes ?? "",
    });
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setEditingId(null);
    setForm(emptyExpense());
  }

  function closeAudit() {
    setAuditOpen(false);
    setAuditExpense(null);
    setAuditLogs([]);
    setAuditError(null);
  }

  async function openAudit(expense: Expense) {
    if (user?.role !== "admin") {
      toast("Only admins can view expense logs");
      return;
    }
    setAuditExpense(expense);
    setAuditOpen(true);
    setAuditLoading(true);
    setAuditError(null);
    try {
      setAuditLogs(await api.listExpenseAudit(expense.id));
    } catch (e) {
      setAuditError((e as Error).message);
    } finally {
      setAuditLoading(false);
    }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        amount: parseNumberInput(form.amount),
        currency: form.currency as "USD" | "LBP",
        date: form.date,
        method: form.method,
        paidBy: form.paidBy,
        notes: form.notes.trim(),
      };
      if (editingId) {
        await api.updateExpense(editingId, payload);
        toast("Expense updated");
      } else {
        await api.createExpense(payload);
        toast("Expense added");
      }
      closeModal();
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Track clinic running costs."
        action={
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add expense
          </Button>
        }
      />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <>
          <Card className="mb-6">
            <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormRow label="View expenses">
                <Select value={mode} onChange={(e) => setMode(e.target.value as PeriodMode)}>
                  <option value="month">By month</option>
                  <option value="week">By week</option>
                  <option value="day">Specific day</option>
                  <option value="range">Custom range</option>
                  <option value="all">All time</option>
                </Select>
              </FormRow>
              {mode === "month" && (
                <FormRow label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></FormRow>
              )}
              {mode === "week" && (
                <FormRow label="Any day in the week"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></FormRow>
              )}
              {mode === "day" && (
                <FormRow label="Date"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></FormRow>
              )}
              {mode === "range" && (
                <>
                  <FormRow label="From"><Input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} /></FormRow>
                  <FormRow label="To"><Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} /></FormRow>
                </>
              )}
            </CardBody>
          </Card>

          <p className="mb-3 text-sm text-slate-500">
            Showing <span className="font-medium text-slate-700">{filtered.length}</span> of {expenses.length}{" "}
            {expenses.length === 1 ? "expense" : "expenses"} for{" "}
            <span className="font-medium text-slate-700">{periodLabel}</span>
          </p>

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Total expenses (USD)" value={formatMoney(totalUSD, "USD")} tone="rose" />
            <StatCard label="Records" value={String(filtered.length)} tone="slate" />
          </div>

          <Card>
            <Table>
              <THead>
                <TR>
                  <TH>Title</TH>
                  <TH>Amount</TH>
                  <TH>Paid by</TH>
                  <TH>Method</TH>
                  <TH>Date</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {filtered.map((e) => (
                  <TR key={e.id}>
                    <TD className="font-medium">{e.title}</TD>
                    <TD className="font-medium text-rose-600">
                      <div className="flex items-center gap-2">
                        <span>{formatMoney(e.amount, e.currency)}</span>
                        {user?.role === "admin" && e.amountEdited && (
                          <span onDoubleClick={() => openAudit(e)} title="Double-click to open expense logs">
                            <Badge tone="amber" className="cursor-pointer select-none">Altered</Badge>
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD className="text-slate-500">{e.paidBy || "—"}</TD>
                    <TD className="capitalize text-slate-500">{e.method.replace("_", " ")}</TD>
                    <TD className="text-slate-500">{formatDate(e.date)}</TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(e)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                    </TD>
                  </TR>
                ))}
                {filtered.length === 0 && (
                  <TR>
                    <TD colSpan={6} className="py-6 text-center text-slate-400">No expenses for {periodLabel}.</TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>
        </>
      )}

      <Modal
        open={open}
        onClose={closeModal}
        title={editingId ? "Edit expense" : "Add expense"}
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button onClick={save} disabled={saving || !canSave}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Save expense"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Title *" className="sm:col-span-2">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Electricity bill" className={cn(form.title.trim() === "" && missingClass)} />
          </FormRow>
          <FormRow label="Amount *"><MoneyInput value={form.amount} onValueChange={(amount) => setForm({ ...form, amount })} placeholder="0" className={cn((form.amount.trim() === "" || parseNumberInput(form.amount) <= 0) && missingClass)} /></FormRow>
          <FormRow label="Currency *">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="USD">USD ($)</option>
              <option value="LBP">Lebanese pound (LBP)</option>
            </Select>
          </FormRow>
          <FormRow label="Date *">
            {/* F8: the date is fixed once an expense is created — it can't be moved
                to another period. Editable only when adding a new expense. */}
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              disabled={!!editingId}
              className={cn(form.date === "" && missingClass, !!editingId && "cursor-not-allowed bg-slate-50 text-slate-500")}
            />
            {editingId && <p className="mt-1 text-xs text-slate-400">The date can’t be changed after an expense is created.</p>}
          </FormRow>
          <FormRow label="Payment method *">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={cn(form.method === "" && missingClass)}>
              {PAYMENT_METHOD_VALUES.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </Select>
          </FormRow>
          <FormRow label="Paid by">
            <Input value={form.paidBy} onChange={(e) => setForm({ ...form, paidBy: e.target.value })} placeholder="Who paid?" />
          </FormRow>
          <FormRow label="Notes *" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What was this expense for?" className={cn(form.notes.trim() === "" && missingClass)} />
          </FormRow>
        </div>
      </Modal>

      <Modal
        open={auditOpen}
        onClose={closeAudit}
        title={auditExpense ? `Expense logs: ${auditExpense.title}` : "Expense logs"}
        footer={<Button variant="ghost" onClick={closeAudit}>Close</Button>}
      >
        {auditLoading ? (
          <Loading />
        ) : auditError ? (
          <ErrorState message={auditError} />
        ) : auditLogs.length === 0 ? (
          <p className="text-sm text-slate-500">No logs recorded for this expense.</p>
        ) : (
          <div className="space-y-3">
            {auditLogs.map((log) => (
              <div key={log.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-800">{log.action}</p>
                  <span className="text-xs text-slate-400">{formatDateTime(log.timestamp)}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">By {log.user}</p>
                <p className="mt-2 text-sm text-slate-700">{log.entityLabel}</p>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
