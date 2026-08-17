"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  consultation_fee: "Consultation fees",
  treatment: "Treatments & sessions",
  package: "Prepaid packages",
  product: "Products",
  blood_test: "Blood tests",
  custom: "Other charges",
};

/**
 * What the period's revenue was earned FROM, with the cost and margin of each
 * category beside it.
 *
 * The rows sum to the Revenue card exactly — they are the same settled basket
 * lines, grouped rather than re-derived, so this drawer can never disagree with
 * the figure it opens from.
 *
 * "Prepaid packages" is revenue from packages and session plans SOLD in this
 * period, recognized in full at the sale. Sessions delivered from a package
 * bought earlier appear nowhere here: they were already counted when they were
 * bought, and counting them again on use would be the same money twice.
 */
export function RevenueKindBreakdown({
  open,
  onClose,
  periodLabel,
  rows,
  revenue,
  cogs,
}: {
  open: boolean;
  onClose: () => void;
  periodLabel: string;
  rows: { kind: string; revenue: number; cogs: number }[];
  revenue: number;
  cogs: number;
}) {
  const grossProfit = revenue - cogs;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Revenue by category"
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    >
      <p className="mb-4 text-sm text-slate-500">
        What was earned {periodLabel}, and what it cost. A prepaid package or session
        plan is counted once, in full, in the period it was <em>sold</em> — using those
        sessions later adds nothing here.
      </p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          Nothing was sold in this period.
        </p>
      ) : (
        <div>
          <div className="space-y-1">
            {rows.map((r) => {
              const margin = r.revenue - r.cogs;
              const pct = r.revenue > 0 ? Math.round((margin / r.revenue) * 1000) / 10 : null;
              return (
                <div key={r.kind} className="rounded-lg border border-slate-100 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-slate-800">
                      {KIND_LABELS[r.kind] ?? r.kind}
                    </span>
                    <span className="text-sm font-semibold text-emerald-600">
                      {formatMoney(r.revenue)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between gap-3 border-t border-slate-100 pt-1 text-xs text-slate-500">
                    <span>Cost {formatMoney(r.cogs)}</span>
                    <span>
                      Margin{" "}
                      <span className="font-medium text-slate-600">{formatMoney(margin)}</span>
                      {pct !== null && <span className="text-slate-400"> · {pct}%</span>}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 space-y-1 border-t border-slate-200 px-3 pt-3 text-sm">
            <div className="flex items-center justify-between text-slate-600">
              <span>Total revenue</span>
              <span className="font-semibold">{formatMoney(revenue)}</span>
            </div>
            <div className="flex items-center justify-between text-slate-600">
              <span>Cost of goods sold</span>
              <span className="font-semibold">−{formatMoney(cogs)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
              <span>Gross profit</span>
              <span>{formatMoney(grossProfit)}</span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
