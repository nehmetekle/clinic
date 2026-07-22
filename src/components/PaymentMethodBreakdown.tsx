"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/utils";
import { paymentMethodBreakdownRows } from "@/lib/types";

/**
 * Drill-down behind an "amount collected" figure: the total split by payment
 * method for the period/date currently in view. Opened from the collected-money
 * stat cards on the front-desk dashboard, the Payments page, and the admin
 * dashboard/reports — matching the referrer-cost / outstanding-debt modal style.
 *
 * `byMethod` is keyed by the RAW method value stored on each payment, so the
 * breakdown reflects what was actually recorded — a method later removed from the
 * offered choices still appears under its own original label, never folded into
 * another bucket. Only methods with a non-zero amount are shown; a genuinely
 * blank/missing value surfaces as "Other". All amounts are USD (LBP payments
 * folded at their frozen rate, like the total).
 */
export function PaymentMethodBreakdown({
  open,
  onClose,
  title = "Collected by payment method",
  periodLabel,
  byMethod,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  periodLabel: string;
  byMethod: Record<string, number>;
}) {
  const rows = paymentMethodBreakdownRows(byMethod);
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    >
      <p className="mb-4 text-sm text-slate-500">
        Amount collected {periodLabel}, split by how it was paid. All figures in USD
        (payments taken in LBP are folded at the rate frozen when they were logged).
      </p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          Nothing collected in this period.
        </p>
      ) : (
        <div>
          <div className="space-y-1">
            {rows.map((r) => (
              <div
                key={r.key || "__other__"}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"
              >
                <span className="text-sm font-medium text-slate-800">{r.label}</span>
                <span className="text-sm font-semibold text-emerald-600">
                  {formatMoney(r.amount, "USD")}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200 px-3 pt-3 text-sm font-semibold text-slate-900">
            <span>Total collected</span>
            <span>{formatMoney(total, "USD")}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
