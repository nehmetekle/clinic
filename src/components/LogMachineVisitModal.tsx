"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatMoney } from "@/lib/utils";
import type { ClientDetail, MachineVisit } from "@/lib/types";

/**
 * Logs a machine-only visit — the fast path for a patient who came in just to use
 * prepaid sessions. Deliberately the whole workflow: pick machines, set counts,
 * confirm. No consultation is opened and nothing clinical is asked for.
 *
 * Used from the client profile (Treatments tab) and the queue board, which is why
 * it takes ids rather than reading a page's state.
 */

type Source = {
  key: string;
  machine: string;
  /** Sessions this source can still deliver — the hard cap on today's entry. */
  left: number;
  /** Prepaid sessions; anything beyond this is billed on confirm. */
  credit: number;
  unitPrice: number;
  currency: "USD" | "LBP";
  sessionPlanId?: string;
  clientPackageId?: string;
};

function sourcesFrom(detail: ClientDetail): Source[] {
  const plans: Source[] = detail.sessionPlans
    .filter((p) => p.status === "active" && p.sessionsLeftToAttend > 0)
    .map((p) => ({
      key: `plan:${p.id}`,
      machine: p.machine ?? "Treatment",
      left: p.sessionsLeftToAttend,
      credit: p.credit,
      unitPrice: p.unitPrice,
      currency: p.currency,
      sessionPlanId: p.id,
    }));
  const bundles: Source[] = detail.client.packages
    .filter((p) => p.status === "active" && p.totalSessions - p.usedSessions > 0)
    .map((p) => ({
      key: `pkg:${p.id}`,
      machine: p.machine ?? p.packageName,
      left: p.totalSessions - p.usedSessions,
      credit: p.totalSessions - p.usedSessions, // a bundle is prepaid in full
      unitPrice: 0,
      currency: p.currency,
      clientPackageId: p.id,
    }));
  return [...plans, ...bundles];
}

export function LogMachineVisitModal({
  open,
  clientId,
  clientName,
  appointmentId,
  preselectKey,
  onClose,
  onLogged,
}: {
  open: boolean;
  clientId: string;
  clientName?: string;
  /** The appointment this visit closes out, when opened from the queue. */
  appointmentId?: string;
  /** Row the staff member clicked "Log visit" on — ticked on open. */
  preselectKey?: string;
  onClose: () => void;
  onLogged?: (visit: MachineVisit) => void;
}) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [idemKey, setIdemKey] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNote("");
    setCounts(preselectKey ? { [preselectKey]: 1 } : {});
    setIdemKey(crypto.randomUUID());
    setLoading(true);
    api
      .getClient(clientId)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, clientId, preselectKey]);

  const sources = useMemo(() => (detail ? sourcesFrom(detail) : []), [detail]);
  const selected = sources.filter((s) => (counts[s.key] ?? 0) > 0);
  const amountDue = selected.reduce(
    (sum, s) => sum + Math.max(0, (counts[s.key] ?? 0) - s.credit) * s.unitPrice,
    0,
  );

  function setCount(key: string, value: number, max: number) {
    setCounts((prev) => {
      const next = { ...prev };
      const n = Math.max(0, Math.min(max, Math.floor(value || 0)));
      if (n === 0) delete next[key];
      else next[key] = n;
      return next;
    });
  }

  async function confirm() {
    if (selected.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const visit = await api.createMachineVisit({
        clientId,
        appointmentId: appointmentId ?? null,
        note: note.trim() || undefined,
        idempotencyKey: idemKey,
        items: selected.map((s) => ({
          sessionPlanId: s.sessionPlanId ?? null,
          clientPackageId: s.clientPackageId ?? null,
          sessions: counts[s.key],
        })),
      });
      toast("Machine visit logged");
      onLogged?.(visit);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={clientName ? `Log machine visit — ${clientName}` : "Log machine visit"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={saving || selected.length === 0}>
            {saving ? "Saving…" : "Confirm"}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : sources.length === 0 ? (
        <p className="text-sm text-slate-400">No prepaid treatments available.</p>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => {
            const count = counts[s.key] ?? 0;
            const billed = Math.max(0, count - s.credit);
            return (
              <div
                key={s.key}
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={count > 0}
                  onChange={(e) => setCount(s.key, e.target.checked ? 1 : 0, s.left)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{s.machine}</p>
                  <p className="text-xs text-slate-500">
                    Remaining: {s.left}
                    {billed > 0 && (
                      <span className="text-amber-600">
                        {" · "}
                        {formatMoney(billed * s.unitPrice, s.currency)} to pay
                      </span>
                    )}
                  </p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={s.left}
                  value={count || ""}
                  placeholder="0"
                  onChange={(e) => setCount(s.key, Number(e.target.value), s.left)}
                  className="h-8 w-16 text-center"
                />
              </div>
            );
          })}
          <div>
            <Label htmlFor="machine-visit-note">Note (optional)</Label>
            <Input
              id="machine-visit-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {amountDue > 0 && (
            <p className="text-sm text-slate-600">
              Amount due <span className="font-semibold text-amber-600">{formatMoney(amountDue)}</span>
            </p>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
