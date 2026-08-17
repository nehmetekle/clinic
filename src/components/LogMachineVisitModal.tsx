"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { ClientDetail, MachineVisit } from "@/lib/types";

/**
 * Logs a machine-only visit — the fast path for a patient who came in just to use
 * sessions they already own. Deliberately the whole workflow: pick machines, set
 * counts, confirm. No consultation is opened, nothing clinical is asked for, and
 * nothing is charged: only settled sessions can be spent here, so the entry is
 * capped at what is available and a patient with none is sent back to the desk.
 *
 * Used from the client profile (Treatments tab) and the queue board, which is why
 * it takes ids rather than reading a page's state.
 */

type Source = {
  key: string;
  machine: string;
  /** Sessions bought, settled and unused — the hard cap on today's entry. */
  available: number;
  sessionPlanId?: string;
  clientPackageId?: string;
};

function sourcesFrom(detail: ClientDetail): Source[] {
  const plans: Source[] = detail.sessionPlans
    .filter((p) => p.status === "active" && p.sessionsAvailable > 0)
    .map((p) => ({
      key: `plan:${p.id}`,
      machine: p.machine ?? "Treatment",
      available: p.sessionsAvailable,
      sessionPlanId: p.id,
    }));
  const bundles: Source[] = detail.client.packages
    .filter((p) => p.status === "active" && p.totalSessions - p.usedSessions > 0)
    .map((p) => ({
      key: `pkg:${p.id}`,
      machine: p.machine ?? p.packageName,
      // A bundle is prepaid in full, so its whole remaining balance is available.
      available: p.totalSessions - p.usedSessions,
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
        <p className="text-sm text-slate-400">No sessions available. Sell sessions first.</p>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => {
            const count = counts[s.key] ?? 0;
            return (
              <div
                key={s.key}
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={count > 0}
                  onChange={(e) => setCount(s.key, e.target.checked ? 1 : 0, s.available)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{s.machine}</p>
                  <p className="text-xs text-slate-500">Available: {s.available}</p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={s.available}
                  value={count || ""}
                  placeholder="0"
                  onChange={(e) => setCount(s.key, Number(e.target.value), s.available)}
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
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
