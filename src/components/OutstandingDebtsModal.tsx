"use client";

import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/utils";

// One row per client that owes money, with their total outstanding in USD.
export type DebtorRow = { id: string; name: string; amount: number };

/**
 * Shared "who owes money" breakdown — opened by clicking the Outstanding-debt
 * stat card on Payments, the dashboard, and Reports, so the same list surfaces
 * everywhere the figure is shown. Each row links to that client's profile.
 */
export function OutstandingDebtsModal({
  rows,
  onClose,
}: {
  rows: DebtorRow[];
  onClose: () => void;
}) {
  const sorted = [...rows].filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((s, r) => s + r.amount, 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Outstanding debt by client"
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    >
      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No client currently owes a balance.</p>
      ) : (
        <div>
          <div className="space-y-1">
            {sorted.map((r) => (
              <Link
                key={r.id}
                href={`/clients/${r.id}`}
                onClick={onClose}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
              >
                <span className="text-sm font-medium text-slate-800">{r.name}</span>
                <span className="text-sm font-semibold text-rose-600">{formatMoney(r.amount, "USD")}</span>
              </Link>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200 px-3 pt-3">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {sorted.length} {sorted.length === 1 ? "client" : "clients"}
            </span>
            <span className="text-sm font-semibold text-slate-900">{formatMoney(total, "USD")}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
