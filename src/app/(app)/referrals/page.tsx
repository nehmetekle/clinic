"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatDate, formatMoney } from "@/lib/utils";

/**
 * The referral-commission ledger (admin only).
 *
 * Three figures that mean different things and must never be added together:
 *
 *   Incurred    — what the clinic became liable for. An EXPENSE, recognized once,
 *                 when a referred patient's first visit completed.
 *   Paid        — what has actually been transferred to referrers. CASH OUT. It
 *                 is deliberately NOT an expense: that was already recognized.
 *   Outstanding — incurred − paid − voided. A BALANCE, so it is never windowed by
 *                 a period, exactly like "Outstanding from Jessy".
 */
export default function ReferralsPage() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi(() => api.getReferralLedger());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [voidFor, setVoidFor] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [referrerFilter, setReferrerFilter] = useState<string | null>(null);
  const [expandedPayout, setExpandedPayout] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const allOutstanding = data.commissions.filter((c) => c.status === "incurred");
  const referrerNames = Array.from(new Set(allOutstanding.map((c) => c.referrerName))).sort();
  const outstanding = referrerFilter
    ? allOutstanding.filter((c) => c.referrerName === referrerFilter)
    : allOutstanding;
  // A payout settles one referrer at a time — a single reference number can't
  // honestly describe money sent to two different people.
  const selectedRows = outstanding.filter((c) => selected.has(c.id));
  const selectedReferrer = selectedRows[0]?.referrerName;
  const selectedTotal = selectedRows.reduce((s, c) => s + c.amount, 0);
  const mixedReferrers = new Set(selectedRows.map((c) => c.referrerName)).size > 1;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFor(referrerName: string) {
    setSelected(
      new Set(allOutstanding.filter((c) => c.referrerName === referrerName).map((c) => c.id)),
    );
  }

  function filterByReferrer(referrerName: string) {
    setReferrerFilter((prev) => (prev === referrerName ? null : referrerName));
  }

  async function submitPayout() {
    if (selectedRows.length === 0) return;
    setSaving(true);
    try {
      const result = await api.recordReferralPayout({
        commissionIds: selectedRows.map((c) => c.id),
        notes: notes.trim() || undefined,
        // One key per confirm, so a double-click resolves to the same payout
        // instead of paying the same commissions twice.
        idempotencyKey: `payout-${selectedRows.map((c) => c.id).sort().join("-")}-${Date.now()}`,
      });
      toast(`Recorded ${formatMoney(result.amount)} paid to ${selectedReferrer}`);
      setPayoutOpen(false);
      setSelected(new Set());
      setNotes("");
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function submitVoid() {
    if (!voidFor || !voidReason.trim()) return;
    setSaving(true);
    try {
      await api.voidReferralCommission(voidFor, { reason: voidReason.trim() });
      toast("Commission written off");
      setVoidFor(null);
      setVoidReason("");
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
        title="Referral commissions"
        subtitle="What the clinic owes the people who send it patients, and what it has paid them."
        action={
          <Button
            onClick={() => setPayoutOpen(true)}
            disabled={selectedRows.length === 0 || mixedReferrers}
          >
            Record payout
            {selectedRows.length > 0 && !mixedReferrers ? ` (${formatMoney(selectedTotal)})` : ""}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Incurred (all time)" value={formatMoney(data.summary.incurred)} tone="rose" />
        <StatCard label="Paid to referrers" value={formatMoney(data.summary.paid)} tone="brand" />
        <StatCard label="Still owed" value={formatMoney(data.summary.outstanding)} tone="amber" />
      </div>

      <p className="mt-3 text-sm text-slate-500">
        A commission is incurred when a referred patient&apos;s <strong>first visit
        completes</strong> — registering a patient who never attends costs nothing. The
        amount is the referrer&apos;s rate at that moment, frozen. Paying it later moves
        cash and is never recorded as an expense again. <strong>Still owed</strong> is a
        current balance, not a figure for any period.
      </p>

      {mixedReferrers && (
        <p className="mt-3 text-sm font-medium text-amber-700">
          A payout covers one referrer at a time — deselect the others first.
        </p>
      )}

      <div className="mt-6">
        <Card>
          <CardHeader
            title="Outstanding commissions"
            subtitle={
              referrerFilter
                ? `${outstanding.length} unpaid — filtered to ${referrerFilter}`
                : `${outstanding.length} unpaid`
            }
          />
          {referrerNames.length > 1 && (
            <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-3 sm:px-6">
              <button
                onClick={() => setReferrerFilter(null)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  referrerFilter === null
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-slate-200 text-slate-500 hover:border-brand-300 hover:text-brand-600"
                }`}
              >
                All referrers
              </button>
              {referrerNames.map((name) => (
                <button
                  key={name}
                  onClick={() => filterByReferrer(name)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    referrerFilter === name
                      ? "border-brand-600 bg-brand-600 text-white"
                      : "border-slate-200 text-slate-500 hover:border-brand-300 hover:text-brand-600"
                  }`}
                >
                  {name}
                  <span className="ml-1 opacity-70">
                    ({allOutstanding.filter((c) => c.referrerName === name).length})
                  </span>
                </button>
              ))}
            </div>
          )}
          {outstanding.length === 0 ? (
            <CardBody className="text-sm text-slate-400">
              {referrerFilter
                ? `Nothing outstanding for ${referrerFilter}.`
                : "Nothing is owed to any referrer."}
            </CardBody>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{""}</TH>
                  <TH>Referrer</TH>
                  <TH>Patient</TH>
                  <TH>Incurred</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>{""}</TH>
                </TR>
              </THead>
              <TBody>
                {outstanding.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select ${c.clientName}'s commission`}
                        className="h-4 w-4 accent-brand-600"
                      />
                    </TD>
                    <TD className="font-medium">
                      <button
                        onClick={() => selectAllFor(c.referrerName)}
                        onDoubleClick={() => filterByReferrer(c.referrerName)}
                        title="Click to select all of this referrer's commissions, double-click to filter"
                        className="text-brand-600 hover:underline"
                      >
                        {c.referrerName}
                      </button>
                    </TD>
                    <TD>
                      <Link href={`/clients/${c.clientId}`} className="text-brand-600 hover:underline">
                        {c.clientName}
                      </Link>
                    </TD>
                    <TD className="text-slate-500">{formatDate(c.incurredAt)}</TD>
                    <TD className="text-right font-medium">{formatMoney(c.amount)}</TD>
                    <TD>
                      <Button variant="outline" onClick={() => setVoidFor(c.id)}>
                        Write off
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader title="Payout history" subtitle="Cash paid to referrers — never re-recorded as an expense" />
          {data.payouts.length === 0 ? (
            <CardBody className="text-sm text-slate-400">No payouts recorded yet.</CardBody>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Paid</TH>
                  <TH>Referrer</TH>
                  <TH>Commissions</TH>
                  <TH>Recorded by</TH>
                  <TH className="text-right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                {data.payouts.map((p) => (
                  <Fragment key={p.id}>
                    <TR
                      className="cursor-pointer hover:bg-slate-50"
                      onClick={() => setExpandedPayout((prev) => (prev === p.id ? null : p.id))}
                    >
                      <TD className="text-slate-500">{formatDate(p.paidAt)}</TD>
                      <TD className="font-medium">{p.referrerName}</TD>
                      <TD className="text-brand-600 hover:underline">
                        {p.commissionCount} client{p.commissionCount === 1 ? "" : "s"}
                      </TD>
                      <TD className="text-slate-500">{p.recordedByName ?? "—"}</TD>
                      <TD className="text-right font-medium">{formatMoney(p.amount)}</TD>
                    </TR>
                    {expandedPayout === p.id && (
                      <TR key={`${p.id}-detail`}>
                        <TD colSpan={5} className="whitespace-normal bg-slate-50">
                          <div className="flex flex-col gap-1 py-1 text-sm">
                            {p.notes && (
                              <p className="mb-1 text-slate-500">
                                <span className="font-medium text-slate-600">Notes: </span>
                                {p.notes}
                              </p>
                            )}
                            {p.clients.map((c) => (
                              <div key={c.clientId} className="flex justify-between gap-4">
                                <Link
                                  href={`/clients/${c.clientId}`}
                                  className="text-brand-600 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {c.clientName}
                                </Link>
                                <span className="text-slate-500">{formatMoney(c.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </TD>
                      </TR>
                    )}
                  </Fragment>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <Modal
        open={payoutOpen}
        onClose={() => setPayoutOpen(false)}
        title={`Record payout to ${selectedReferrer ?? ""}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setPayoutOpen(false)}>Cancel</Button>
            <Button onClick={submitPayout} disabled={saving}>
              {saving ? "Recording…" : `Record ${formatMoney(selectedTotal)}`}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-slate-500">
          Settling {selectedRows.length} commission{selectedRows.length === 1 ? "" : "s"} totalling{" "}
          <strong>{formatMoney(selectedTotal)}</strong>.
        </p>
        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium text-slate-500">
            Notes
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
          </label>
        </div>
      </Modal>

      <Modal
        open={voidFor !== null}
        onClose={() => setVoidFor(null)}
        title="Write off commission"
        footer={
          <>
            <Button variant="outline" onClick={() => setVoidFor(null)}>Cancel</Button>
            <Button onClick={submitVoid} disabled={saving || !voidReason.trim()}>
              {saving ? "Saving…" : "Write off"}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-slate-500">
          The commission stays in the ledger as written off, with who did it and why —
          it is not deleted. It stops counting toward what the clinic owes.
        </p>
        <label className="text-xs font-medium text-slate-500">
          Reason (required)
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="mt-1" />
        </label>
      </Modal>
    </div>
  );
}
