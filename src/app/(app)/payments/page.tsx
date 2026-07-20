"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { FormRow, Input, MoneyInput, Select } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { useClientSearch } from "@/lib/use-client-search";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { CLINIC, toUsdFrozen, todayIso } from "@/lib/config";
import { formatDate, formatMoney, moneyCap, parseNumberInput } from "@/lib/utils";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  type Client,
  type PaymentMethod,
} from "@/lib/types";

const EMPTY = {
  clientId: "",
  motif: "",
  amountPaid: "",
  currency: "USD",
  method: "cash",
};

export default function PaymentsPage() {
  const router = useRouter();
  const { toast } = useToast();
  // The list is scoped to one clinic-day and defaults to today, like the
  // appointments view. Changing the date re-fetches server-side (deps below).
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const isToday = selectedDate === todayIso();
  const { data, loading, error, refetch } = useApi(
    () => api.listPayments(selectedDate),
    [selectedDate],
  );
  const debts = useApi(() => api.listOutstandingDebts());
  const settings = useApi(() => api.getSettings());
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [clientQuery, setClientQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  // Shared server-side search; suppressed once a client is picked. Capped at 8 in
  // the dropdown below.
  const { results: clientResults, loading: searchingClients } = useClientSearch(
    selectedClient ? "" : clientQuery,
    { minChars: 2 },
  );
  const [saving, setSaving] = useState(false);
  // R2: one idempotency key per opened form, reused across retries of the SAME
  // payment so a double-click / resubmit can't create a second income row.
  const [idemKey, setIdemKey] = useState("");

  const payments = data ?? [];
  // USD is the single source of truth: LBP payments fold into the same USD total
  // at the rate frozen on each record when it was logged (not today's rate).
  const fallbackRate = settings.data?.usdToLbp ?? CLINIC.defaultUsdToLbp;
  const sumUsd = (fn: (p: (typeof payments)[number]) => number) =>
    payments.reduce((s, p) => s + toUsdFrozen(fn(p), p.currency, p.usdToLbp, fallbackRate), 0);
  const collectedUSD = sumUsd((p) => p.amountPaid);
  // Money owed = outstanding tracked debts (not a payment-based charged-minus-paid figure).
  const outstandingUSD = (debts.data ?? []).reduce(
    (s, d) => s + toUsdFrozen(d.amount, d.currency, d.usdToLbp, fallbackRate),
    0,
  );

  // R5: an amount over the sane cap for its currency is rejected with a clear
  // inline message rather than being silently accepted as an absurd receipt.
  const amountTooLarge = parseNumberInput(form.amountPaid) > moneyCap(form.currency);
  // Motif and amount are required; the client is optional (general payments have none).
  const canSave =
    form.motif.trim() !== "" &&
    parseNumberInput(form.amountPaid) > 0 &&
    !amountTooLarge;

  function openPaymentModal() {
    setForm(EMPTY);
    setClientQuery("");
    setSelectedClient(null);
    setIdemKey(crypto.randomUUID());
    setOpen(true);
  }

  function closePaymentModal() {
    setOpen(false);
    setForm(EMPTY);
    setClientQuery("");
    setSelectedClient(null);
  }

  function pickClient(client: Client) {
    setSelectedClient(client);
    setClientQuery(`${client.firstName} ${client.lastName} · ${client.phone}`);
    setForm((f) => ({ ...f, clientId: client.id }));
  }

  function updateClientQuery(value: string) {
    setClientQuery(value);
    setSelectedClient(null);
    setForm((f) => ({ ...f, clientId: "" }));
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await api.createPayment({
        clientId: form.clientId || undefined,
        motif: form.motif.trim(),
        amountPaid: parseNumberInput(form.amountPaid),
        currency: form.currency as "USD" | "LBP",
        method: form.method as PaymentMethod,
        idempotencyKey: idemKey,
      });
      toast("Payment recorded");
      closePaymentModal();
      // The new payment is dated now, so make sure it's visible: if we're viewing
      // a past date, jump to today (auto-refetches); otherwise refresh in place.
      if (isToday) refetch();
      else setSelectedDate(todayIso());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Pick a date to see the payments collected that day."
        action={
          <Button onClick={openPaymentModal}>
            <Plus className="h-4 w-4" /> Record payment
          </Button>
        }
      />

      {/* Date picker — mirrors the appointments view; defaults to today. */}
      <Card className="mb-6">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <FormRow label="View date" className="w-44">
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              />
            </FormRow>
            <Button
              variant={isToday ? "primary" : "outline"}
              onClick={() => setSelectedDate(todayIso())}
            >
              Today
            </Button>
          </div>
        </CardBody>
      </Card>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4">
            {/* Scoped to the viewed day, so it reads as that day's till total. */}
            <StatCard
              label={isToday ? "Collected today (USD)" : "Collected (USD)"}
              value={formatMoney(collectedUSD, "USD")}
              hint={formatDate(selectedDate)}
              tone="green"
            />
            {/* Outstanding debt is a live running total across all clients, not
                tied to the viewed date. Clicking opens the list of debtors. */}
            <StatCard
              label="Outstanding debt (USD)"
              value={formatMoney(outstandingUSD, "USD")}
              hint="All clients · view who owes →"
              tone="rose"
              onClick={() => router.push("/clients?filter=owes")}
            />
          </div>

          <Card>
            <CardHeader
              title={`Payments on ${formatDate(selectedDate)}`}
              subtitle={`${payments.length} payment${payments.length !== 1 ? "s" : ""} collected`}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Receipt</TH>
                  <TH>Client</TH>
                  <TH>Motif</TH>
                  <TH>Amount</TH>
                  <TH>Method</TH>
                  <TH>Date</TH>
                  <TH>Recorded by</TH>
                </TR>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs">{p.receiptNumber}</TD>
                    <TD className="font-medium">{p.clientName ?? "—"}</TD>
                    <TD className="text-slate-500">{p.motif}</TD>
                    <TD className="font-medium">{formatMoney(p.amountPaid, p.currency)}</TD>
                    <TD className="capitalize text-slate-500">{p.method.replace("_", " ")}</TD>
                    <TD className="text-slate-500">{formatDate(p.date)}</TD>
                    <TD className="text-slate-500">{p.createdByName ?? "—"}</TD>
                  </TR>
                ))}
                {payments.length === 0 && (
                  <TR>
                    <TD colSpan={7} className="py-8 text-center text-slate-400">
                      No payments collected on this date.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </Card>
        </>
      )}

      <Modal
        open={open}
        onClose={closePaymentModal}
        title="Record payment"
        footer={
          <>
            <Button variant="ghost" onClick={closePaymentModal}>Cancel</Button>
            <Button onClick={save} disabled={saving || !canSave}>{saving ? "Saving…" : "Save payment"}</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Motif = what this payment is for. Required. Free-text on purpose:
              bundles are NOT payable here — a bundle sale happens inside a
              consultation (the dietitian starts it), which charges it through the
              visit basket AND grants its sessions; recording a bundle payment from
              this modal would take the money without creating the sessions. */}
          <FormRow label="Motif" className="sm:col-span-2">
            <Input
              value={form.motif}
              onChange={(e) => setForm({ ...form, motif: e.target.value })}
              placeholder="e.g. Consultation, EMS session, no-show fee"
            />
          </FormRow>
          <FormRow label="Client (optional)" className="sm:col-span-2">
            <div className="relative">
              <Input
                value={clientQuery}
                onChange={(e) => updateClientQuery(e.target.value)}
                placeholder="Search by client name or phone"
              />
              {(searchingClients || clientResults.length > 0 || (clientQuery.trim().length >= 2 && !selectedClient)) && (
                <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                  {searchingClients ? (
                    <div className="px-3 py-2 text-sm text-slate-500">Searching…</div>
                  ) : clientResults.length > 0 ? (
                    clientResults.slice(0, 8).map((client) => (
                      <button
                        key={client.id}
                        type="button"
                        onClick={() => pickClient(client)}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="font-medium text-slate-800">{client.firstName} {client.lastName}</span>
                        <span className="ml-2 text-slate-400">{client.phone}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-slate-500">No clients found.</div>
                  )}
                </div>
              )}
            </div>
          </FormRow>
          <FormRow label="Amount received">
            <MoneyInput value={form.amountPaid} onValueChange={(amountPaid) => setForm({ ...form, amountPaid })} placeholder="0" />
            {amountTooLarge && (
              <p className="mt-1 text-xs text-rose-600">
                Amount is unreasonably large (max {moneyCap(form.currency).toLocaleString()} {form.currency}).
              </p>
            )}
          </FormRow>
          <FormRow label="Currency">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="USD">USD ($)</option>
              <option value="LBP">Lebanese pound (LBP)</option>
            </Select>
          </FormRow>
          <FormRow label="Method">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {PAYMENT_METHOD_VALUES.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </Select>
          </FormRow>
          <p className="sm:col-span-2 text-xs text-slate-400">
            Records the amount actually collected. Bundles are not sold here — the dietitian starts
            one during a consultation, which charges it and grants its sessions. If the client still
            owes a balance, settle it at the visit basket so the remainder is tracked as a debt.
            Receipt number is generated automatically.
          </p>
        </div>
      </Modal>
    </div>
  );
}
