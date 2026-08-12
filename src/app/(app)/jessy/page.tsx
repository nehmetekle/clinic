"use client";

import { useState } from "react";
import Link from "next/link";
import { HandCoins } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { Modal } from "@/components/ui/Modal";
import { FormRow, MoneyInput, Textarea } from "@/components/ui/Field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils";

/**
 * The Jessy ledger. Jessy is a third-party payer: when a patient settles through
 * it, the clinic books the income immediately (a normal payment, visible in the
 * payment-method breakdown) and Jessy takes on the obligation to transfer that
 * money. This page tracks that obligation and the transfers that clear it.
 *
 * The three figures are deliberately distinct and are never added together:
 * "Paid through Jessy" is income already counted; "Settled by Jessy" is money
 * received against it; "Outstanding" is what's left to arrive.
 */
export default function JessyPage() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi(() => api.getJessyReport());
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Second step: the typed amount is read back for explicit confirmation before
  // anything is written. A settlement can't be undone (there is no reversal in
  // this product), so a mistyped amount would be permanent — this step is always
  // required, never skippable.
  const [confirming, setConfirming] = useState(false);
  // Frozen when the confirmation step opens, so double-clicking "Yes" resends the
  // SAME key and the server applies the transfer once. Generating it per-click
  // (as this used to) meant every click looked like a brand-new transfer.
  const [submitKey, setSubmitKey] = useState("");

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const { summary, receivables, settlements } = data;
  const outstandingRows = receivables.filter((r) => r.remaining > 0);
  const entered = Number(amount || 0);
  // Mirrors the server's refusal so the secretary sees it before submitting —
  // the authoritative check still runs inside the settlement transaction.
  const overSettling = entered - summary.outstanding > 0.005;
  const canSubmit = entered > 0 && !overSettling && !saving;

  function closeModal() {
    setOpen(false);
    setAmount("");
    setNotes("");
    setConfirming(false);
    setSubmitKey("");
  }

  /** Step 1 → 2. Freezes the idempotency key for this specific attempt. */
  function askToConfirm() {
    if (!canSubmit) return;
    setSubmitKey(`jessy-settlement-${Date.now()}-${entered}`);
    setConfirming(true);
  }

  async function record() {
    if (!canSubmit || !confirming) return;
    setSaving(true);
    try {
      await api.recordJessySettlement({
        amount: entered,
        notes: notes.trim() || undefined,
        // Same key for every click of "Yes": a repeat returns the current balance
        // instead of drawing the receivables down twice.
        idempotencyKey: submitKey,
      });
      toast(`Recorded ${formatMoney(entered)} received from Jessy`);
      closeModal();
      refetch();
    } catch (e) {
      toast((e as Error).message);
      // Drop back to the form so the amount can be corrected rather than
      // re-confirmed blindly.
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Jessy"
        subtitle="Third-party payer ledger."
        action={
          <Button onClick={() => setOpen(true)} disabled={summary.outstanding <= 0}>
            <HandCoins className="h-4 w-4" /> Record transfer
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Settled by Jessy" value={formatMoney(summary.settled)} tone="blue" />
        <StatCard label="Outstanding from Jessy" value={formatMoney(summary.outstanding)} tone="amber" />
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Outstanding receivables"
            subtitle={`${outstandingRows.length} visit${outstandingRows.length === 1 ? "" : "s"} awaiting transfer`}
          />
          <Table>
            <THead>
              <TR>
                <TH>Date</TH><TH>Patient</TH><TH>Receipt</TH>
                <TH className="text-right">Original</TH><TH className="text-right">Still owed</TH>
              </TR>
            </THead>
            <TBody>
              {outstandingRows.map((r) => (
                <TR key={r.id}>
                  <TD className="text-slate-500">{formatDate(r.createdAt)}</TD>
                  <TD className="font-medium">
                    {r.clientId ? (
                      <Link href={`/clients/${r.clientId}`} className="text-brand-600 hover:underline">
                        {r.clientName}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    {r.visitNumber !== undefined && (
                      <span className="ml-1.5 text-xs text-slate-400">visit {r.visitNumber}</span>
                    )}
                  </TD>
                  <TD className="text-slate-500">{r.receiptNumber}</TD>
                  <TD className="text-right text-slate-500">{formatMoney(r.amount)}</TD>
                  <TD className="text-right font-medium text-amber-600">{formatMoney(r.remaining)}</TD>
                </TR>
              ))}
              {outstandingRows.length === 0 && (
                <TR><TD colSpan={5} className="py-6 text-center text-slate-400">Jessy owes the clinic nothing right now.</TD></TR>
              )}
            </TBody>
          </Table>
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Settlement history"
            subtitle={`${settlements.length} transfer${settlements.length === 1 ? "" : "s"} received`}
          />
          <Table>
            <THead>
              <TR>
                <TH>Received</TH><TH>Recorded by</TH>
                <TH>Applied to</TH><TH className="text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {settlements.map((s) => (
                <TR key={s.id}>
                  <TD className="text-slate-500">{formatDateTime(s.createdAt)}</TD>
                  <TD className="text-slate-500">{s.recordedByName ?? "—"}</TD>
                  <TD className="!whitespace-normal text-xs text-slate-500">
                    {s.allocations
                      .map((a) => `${a.receiptNumber} (${formatMoney(a.amount)})`)
                      .join(", ")}
                  </TD>
                  <TD className="text-right font-medium text-emerald-600">{formatMoney(s.amount)}</TD>
                </TR>
              ))}
              {settlements.length === 0 && (
                <TR><TD colSpan={4} className="py-6 text-center text-slate-400">No transfers recorded from Jessy yet.</TD></TR>
              )}
            </TBody>
          </Table>
        </Card>
      </div>

      <Modal
        open={open}
        onClose={closeModal}
        title={confirming ? "Confirm the amount" : "Record a transfer from Jessy"}
        footer={
          confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={saving}>
                Back
              </Button>
              <Button onClick={record} disabled={!canSubmit}>
                {saving ? "Recording…" : "Yes, record it"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={closeModal}>Cancel</Button>
              <Button onClick={askToConfirm} disabled={!canSubmit}>Continue</Button>
            </>
          )
        }
      >
        <CardBody className="!px-0 !py-0">
          {confirming ? (
            // Read the amount back before writing. A recorded transfer is
            // permanent, so a typo caught here is the only place it can be caught.
            <div>
              <p className="text-sm text-slate-500">
                Record this amount as received from Jessy?
              </p>
              <p className="my-4 text-center text-3xl font-semibold text-slate-900">
                {formatMoney(entered)}
              </p>
              <p className="text-sm text-slate-500">
                Jessy will still owe{" "}
                <span className="font-semibold text-slate-800">
                  {formatMoney(Math.max(0, Math.round((summary.outstanding - entered) * 100) / 100))}
                </span>{" "}
                afterwards. This can’t be undone.
              </p>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-slate-500">
                Jessy currently owes{" "}
                <span className="font-semibold text-slate-800">{formatMoney(summary.outstanding)}</span>.
              </p>
              <FormRow label="Amount received (USD) *">
                <MoneyInput value={amount} onValueChange={setAmount} placeholder="0" autoFocus />
                {overSettling && (
                  <p className="mt-1 text-xs text-rose-600">
                    Jessy only owes {formatMoney(summary.outstanding)} — you can’t settle more than that.
                  </p>
                )}
              </FormRow>
              <FormRow label="Notes">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </FormRow>
            </>
          )}
        </CardBody>
      </Modal>
    </div>
  );
}
