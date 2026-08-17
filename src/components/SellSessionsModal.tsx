"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatMoney } from "@/lib/utils";
import type { ServicePrice } from "@/lib/types";

/**
 * Sells treatment sessions at the front desk, with no consultation open.
 *
 * It only raises the basket. Settling that basket — paid now, or the balance
 * moved to a ClientDebt — is what unlocks the sessions, which is why this closes
 * straight into the normal checkout rather than collecting money itself.
 */
export function SellSessionsModal({
  open,
  clientId,
  clientName,
  onClose,
  onSold,
}: {
  open: boolean;
  clientId: string;
  clientName?: string;
  onClose: () => void;
  /** Fired with the pending basket id, so the caller can open checkout. */
  onSold?: (basketId: string) => void;
}) {
  const { toast } = useToast();
  const [prices, setPrices] = useState<ServicePrice[]>([]);
  const [machine, setMachine] = useState("");
  const [sessions, setSessions] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setMachine("");
    setSessions("1");
    api
      .listServicePrices()
      .then((rows) => setPrices(rows.filter((p) => p.kind === "treatment" && p.active)))
      .catch((e: Error) => setError(e.message));
  }, [open]);

  const selected = useMemo(() => prices.find((p) => p.key === machine), [prices, machine]);
  const count = Math.max(0, Math.floor(Number(sessions) || 0));
  const total = selected ? selected.price * count : 0;

  async function confirm() {
    if (!machine || count < 1) return;
    setSaving(true);
    setError(null);
    try {
      const { basketId } = await api.sellSessions({ clientId, machine, sessions: count });
      toast("Sessions added to basket");
      onSold?.(basketId);
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
      title={clientName ? `Sell sessions — ${clientName}` : "Sell sessions"}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={saving || !machine || count < 1}>
            {saving ? "Saving…" : "Add to basket"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor="sell-machine">Treatment</Label>
          <Select id="sell-machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="">Select treatment…</option>
            {prices.map((p) => (
              <option key={p.id} value={p.key}>
                {p.name} — {formatMoney(p.price, p.currency)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sell-sessions">Sessions</Label>
          <Input
            id="sell-sessions"
            type="number"
            min={1}
            max={1000}
            value={sessions}
            onChange={(e) => setSessions(e.target.value)}
          />
        </div>
        {selected && count > 0 && (
          <p className="text-sm text-slate-600">
            Total <span className="font-semibold">{formatMoney(total, selected.currency)}</span>
          </p>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    </Modal>
  );
}
