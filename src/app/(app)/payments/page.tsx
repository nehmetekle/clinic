"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { PaymentMethodBreakdown } from "@/components/PaymentMethodBreakdown";
import { FormRow, Input, MoneyInput, Select } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { useClientSearch } from "@/lib/use-client-search";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { todayIso } from "@/lib/config";
import { cardSurchargeAmount, formatDate, formatMoney, moneyCap, parseNumberInput } from "@/lib/utils";
import {
  JESSY_METHOD,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  type Client,
  type PaymentMethod,
  type TenderBreakdownEntry,
} from "@/lib/types";
import {
  TENDER_CURRENCY_LABELS,
  TENDER_CURRENCY_VALUES,
  formatFxRate,
  formatTender,
  formatUsd,
  type TenderCurrency,
} from "@/lib/money";

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
  const [showMethods, setShowMethods] = useState(false);
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
  // `amountUsd` is computed by the SERVER at each payment's own frozen rate — the
  // browser never does FX maths on money, so what it displays cannot disagree with
  // what was banked, and a changed rate cannot move a past day's total.
  const collectedUSD = payments.reduce((s, p) => s + p.amountUsd, 0);
  // Same USD-folded total, split by payment method, for the click-to-open breakdown
  // on the "Collected" card. Scoped to the viewed day like the total itself. Keyed
  // by the RAW method stored on each record — never folded — so a retired method
  // keeps its own label; a blank value collapses to the "" ("Other") bucket.
  const collectedByMethod = payments.reduce<Record<string, number>>((acc, p) => {
    const key = (p.method ?? "").trim();
    acc[key] = (acc[key] ?? 0) + p.amountUsd;
    return acc;
  }, {});
  // Same money keyed by method AND tender currency, for the cash-drawer view in the
  // breakdown modal. Native totals are kept un-normalised — they are the figure the
  // person counting the drawer can actually check.
  const collectedByTender = Object.values(
    payments.reduce<Record<string, TenderBreakdownEntry>>((acc, p) => {
      const method = (p.method ?? "").trim();
      const key = `${method}|${p.currency}`;
      const prev = acc[key];
      acc[key] = {
        method,
        currency: p.currency,
        usd: (prev?.usd ?? 0) + p.amountUsd,
        native: (prev?.native ?? 0) + p.amountPaid,
      };
      return acc;
    }, {}),
  );
  // Money owed = outstanding tracked debts (not a payment-based charged-minus-paid figure).
  const outstandingUSD = (debts.data ?? []).reduce((s, d) => s + d.outstandingAmount, 0);

  // R5: an amount over the sane cap for its currency is rejected with a clear
  // inline message rather than being silently accepted as an absurd receipt.
  const amountTooLarge = parseNumberInput(form.amountPaid) > moneyCap(form.currency);
  // Live preview of the clinic's configured card fee, added on top of the entered
  // amount — mirrors what createPayment always charges for method "card" server-side,
  // so the secretary isn't surprised by the final total.
  const surchargeRate = settings.data?.cardSurchargePercent ?? 0;
  const enteredAmount = parseNumberInput(form.amountPaid);
  const cardSurcharge = cardSurchargeAmount(enteredAmount, form.method, surchargeRate);
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
        currency: form.currency as TenderCurrency,
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
              hint={`${formatDate(selectedDate)} · by method →`}
              tone="green"
              onClick={() => setShowMethods(true)}
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

          <PaymentMethodBreakdown
            open={showMethods}
            onClose={() => setShowMethods(false)}
            title={isToday ? "Collected today by method" : "Collected by method"}
            periodLabel={`on ${formatDate(selectedDate)}`}
            byMethod={collectedByMethod}
            byTender={collectedByTender}
          />

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
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {payments.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs">{p.receiptNumber}</TD>
                    <TD className="font-medium">{p.clientName ?? "—"}</TD>
                    <TD className="text-slate-500">{p.motif}</TD>
                    <TD className="font-medium">
                      {formatTender(p.amountPaid, p.currency)}
                      {p.cardSurchargeAmount > 0 && (
                        <span className="ml-1 text-xs font-normal text-slate-400">
                          (incl. {formatTender(p.cardSurchargeAmount, p.currency)} card fee)
                        </span>
                      )}
                      {/* Foreign tender: the USD the clinic actually banked and the
                          rate frozen on THIS row — never today's. Both are shown
                          because the equivalent alone can't be checked without the
                          rate that produced it. */}
                      {p.currency !== "USD" && (
                        <span className="block text-xs font-normal text-slate-400">
                          ≈ {formatUsd(p.amountUsd)}
                          {p.fxRate !== undefined && ` · ${formatFxRate(p.currency, p.fxRate)}`}
                        </span>
                      )}
                    </TD>
                    <TD className="capitalize text-slate-500">{p.method.replace("_", " ")}</TD>
                    <TD className="text-slate-500">{formatDate(p.date)}</TD>
                    <TD className="text-slate-500">{p.createdByName ?? "—"}</TD>
                    <TD className="text-right">
                      {/* A real link, not a fetch: it opens the browser's own PDF
                          viewer, which owns the print dialog — and "Save as" still
                          works for anyone who wants the file. Same convention as
                          the Food List PDF. */}
                      <a
                        href={api.receiptPrintUrl(p.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-brand-700 hover:underline"
                      >
                        Print
                      </a>
                    </TD>
                  </TR>
                ))}
                {payments.length === 0 && (
                  <TR>
                    <TD colSpan={8} className="py-8 text-center text-slate-400">
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
          <FormRow label="Amount">
            <MoneyInput value={form.amountPaid} onValueChange={(amountPaid) => setForm({ ...form, amountPaid })} placeholder="0" />
            {amountTooLarge && (
              <p className="mt-1 text-xs text-rose-600">
                Amount is unreasonably large (max {moneyCap(form.currency).toLocaleString()} {form.currency}).
              </p>
            )}
            {cardSurcharge > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                <span className="font-medium">Card fee {surchargeRate}%</span>
                <span>+{formatMoney(cardSurcharge, form.currency)}</span>
                <span className="text-amber-400">→</span>
                <span className="font-semibold">
                  {formatMoney(enteredAmount + cardSurcharge, form.currency)} charged
                </span>
              </div>
            )}
          </FormRow>
          <FormRow label="Currency">
            {/* The currency the money was TENDERED in. Jessy's receivable ledger is
                USD-only, so the option list narrows rather than letting the desk
                submit a combination the server refuses. */}
            <Select
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            >
              {(form.method === JESSY_METHOD ? (["USD"] as const) : TENDER_CURRENCY_VALUES).map(
                (c) => (
                  <option key={c} value={c}>{TENDER_CURRENCY_LABELS[c]}</option>
                ),
              )}
            </Select>
            {form.currency !== "USD" && (
              <p className="mt-1 text-xs text-slate-400">
                Recorded as {form.currency}; reports convert it to USD at the rate frozen now.
              </p>
            )}
          </FormRow>
          <FormRow label="Method">
            <Select
              value={form.method}
              onChange={(e) => {
                const method = e.target.value;
                setForm({
                  ...form,
                  method,
                  // Jessy is USD-only — snap back rather than submit an invalid pair.
                  currency: method === JESSY_METHOD ? "USD" : form.currency,
                });
              }}
            >
              {PAYMENT_METHOD_VALUES.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </Select>
          </FormRow>
          <p className="sm:col-span-2 text-xs text-slate-400">
            Records the amount actually collected (plus the card surcharge on top, if configured and
            paid by card). Bundles are not sold here — the doctor starts one during a consultation,
            which charges it and grants its sessions. If the client still owes a balance, settle it at
            the visit basket so the remainder is tracked as a debt. Receipt number is generated
            automatically.
          </p>
        </div>
      </Modal>
    </div>
  );
}
