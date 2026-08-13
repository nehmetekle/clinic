"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/lib/utils";
import { paymentMethodBreakdownRows, type TenderBreakdownEntry } from "@/lib/types";
import { formatTender, formatUsd } from "@/lib/money";

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
  byTender = [],
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  periodLabel: string;
  byMethod: Record<string, number>;
  // Same money, split by method AND tender currency. Rendered as a sub-line under
  // its method ONLY when that method took foreign currency, so a USD-only clinic
  // day looks exactly as it always has. This is the cash-drawer view: the native
  // figure is what the person counting notes can check against.
  byTender?: TenderBreakdownEntry[];
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
        Amount collected {periodLabel}, split by how it was paid. Method totals are USD
        — anything tendered in EUR or LBP is folded at the rate frozen when it was
        logged, and broken out underneath with the native amount for cash-drawer
        reconciliation.
      </p>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          Nothing collected in this period.
        </p>
      ) : (
        <div>
          <div className="space-y-1">
            {rows.map((r) => {
              const tender = byTender
                .filter((t) => t.method === r.key && t.usd > 0)
                .sort((a, b) => b.usd - a.usd);
              const mixed = tender.some((t) => t.currency !== "USD");
              return (
              <div
                key={r.key || "__other__"}
                className="rounded-lg border border-slate-100 px-3 py-2"
              >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-slate-800">{r.label}</span>
                <span className="text-sm font-semibold text-emerald-600">
                  {formatMoney(r.amount, "USD")}
                </span>
              </div>
              {mixed && (
                <ul className="mt-1 space-y-0.5 border-t border-slate-100 pt-1 text-xs text-slate-500">
                  {tender.map((t) => (
                    <li key={t.currency} className="flex justify-between gap-3">
                      <span>{t.currency}</span>
                      <span>
                        <span className="font-medium text-slate-600">
                          {formatTender(t.native, t.currency)}
                        </span>
                        {t.currency !== "USD" && (
                          <span className="text-slate-400"> · {formatUsd(t.usd)}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              </div>
              );
            })}
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
