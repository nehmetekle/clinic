"use client";

import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { formatMoney } from "@/lib/utils";
import type { DashboardSummary } from "@/lib/types";

/**
 * Drill-down behind the "Referrer cost" figure: each referrer owed a commission
 * for patients registered in the selected period, the total owed to them, and the
 * patients that drove it (each with the fee frozen at their registration). Opened
 * from the dashboard/reports "Referrer cost" stat card.
 */
export function ReferrerCostBreakdown({
  open,
  onClose,
  periodLabel,
  report,
}: {
  open: boolean;
  onClose: () => void;
  periodLabel: string;
  report: DashboardSummary["referrerCostReport"];
}) {
  const grandTotal = report.reduce((s, r) => s + r.total, 0);
  return (
    <Modal open={open} onClose={onClose} title="Referrer cost breakdown">
      <p className="mb-4 text-sm text-slate-500">
        Commissions owed for patients registered {periodLabel}. Each patient&apos;s fee
        is frozen at the moment they were registered (the new-client form or a phone
        booking), so it never changes if the referrer&apos;s rate is edited later.
      </p>
      {report.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          No referrer commissions in this period.
        </p>
      ) : (
        <div className="space-y-4">
          {report.map((r) => (
            <div key={r.name} className="rounded-lg border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <span className="font-medium text-slate-800">{r.name}</span>
                <span className="text-sm font-semibold text-rose-600">
                  {formatMoney(r.total)}
                </span>
              </div>
              <ul className="divide-y divide-slate-50">
                {r.patients.map((p) => (
                  <li key={p.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <Link href={`/clients/${p.id}`} className="text-brand-600 hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-slate-500">{formatMoney(p.fee)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-sm font-semibold text-slate-800">
            <span>Total referrer cost</span>
            <span className="text-rose-600">{formatMoney(grandTotal)}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
