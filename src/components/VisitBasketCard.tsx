"use client";

import { ShoppingBasket, Trash2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FormRow, Input, Select, Textarea } from "@/components/ui/Field";
import { basketTotals, formatMoney } from "@/lib/utils";

export type VisitBasketCardItem = {
  id: string;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  covered?: boolean;
  // Lets a single line carry its own remove (X) even when the card isn't in full
  // `editable` mode — e.g. the auto-added consultation fee in the dietitian's
  // editor, which is removable while treatments/products are not.
  removable?: boolean;
  // Suppresses the in-place quantity editor for this line even in `editable` mode
  // — e.g. the secretary settles session/treatment lines exactly as the dietitian
  // sent them (no quantity changes).
  lockQuantity?: boolean;
  // Suppresses the remove (X) for this line even in `editable` mode — e.g. the
  // secretary can't drop the consultation fee (only the dietitian/admin may).
  lockRemove?: boolean;
};

/**
 * The visit basket card — the single source of truth for how a basket looks,
 * shared by the dietitian's editor and the secretary's settlement modal so both
 * see the exact same card. Discount controls render when handlers are supplied;
 * per-item remove + an add control render when `editable`.
 */
export function VisitBasketCard({
  items,
  discountOpen,
  discountType,
  discountValue,
  discountReason = "",
  onToggleDiscount,
  onDiscountTypeChange,
  onDiscountValueChange,
  onDiscountReasonChange,
  editable = false,
  onRemoveItem,
  onItemQuantityChange,
  addControl,
  subtitle = "Items and sessions charged for today.",
  headerAction,
  footer,
  emptyText = "No billable items added yet.",
  currency = "USD",
  usdToLbp,
}: {
  items: VisitBasketCardItem[];
  discountOpen: boolean;
  discountType: "percent" | "amount";
  discountValue: string;
  discountReason?: string;
  onToggleDiscount?: (open: boolean) => void;
  onDiscountTypeChange?: (type: "percent" | "amount") => void;
  onDiscountValueChange?: (value: string) => void;
  onDiscountReasonChange?: (value: string) => void;
  editable?: boolean;
  onRemoveItem?: (id: string) => void;
  // Lets the editor change a charged line's quantity in place (e.g. the client
  // can only pay for 3 of 12 sessions today). Shown for non-covered items only.
  onItemQuantityChange?: (id: string, quantity: number) => void;
  addControl?: React.ReactNode;
  subtitle?: string;
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  emptyText?: string;
  currency?: string;
  // Basket's frozen exchange rate — folds any LBP line into the USD total. When
  // omitted, basketTotals falls back to the default rate (items are USD anyway).
  usdToLbp?: number;
}) {
  const { subtotal, discount, total } = basketTotals(
    items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, covered: i.covered, currency: i.currency })),
    { type: discountOpen ? discountType : undefined, value: Number(discountValue) || 0 },
    usdToLbp,
  );
  const editableDiscount = Boolean(onToggleDiscount);
  // A reason is mandatory once an actual discount amount is entered.
  const reasonMissing =
    discountOpen && (Number(discountValue) || 0) > 0 && !discountReason.trim();

  return (
    <Card>
      <CardHeader
        title="Visit basket"
        subtitle={subtitle}
        action={headerAction ?? <ShoppingBasket className="h-5 w-5 text-slate-400" />}
      />
      <CardBody className="space-y-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-700">Discount</p>
              <p className="text-xs text-slate-400">Optional, applied before saving.</p>
            </div>
            {editableDiscount &&
              (discountOpen ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onToggleDiscount?.(false);
                    onDiscountValueChange?.("");
                  }}
                >
                  Remove
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onToggleDiscount?.(true)}>
                  Add discount
                </Button>
              ))}
          </div>
          {discountOpen && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <FormRow label="Discount type">
                <Select
                  value={discountType}
                  disabled={!editableDiscount}
                  onChange={(e) => onDiscountTypeChange?.(e.target.value as "percent" | "amount")}
                >
                  <option value="percent">Percentage</option>
                  <option value="amount">Dollar amount</option>
                </Select>
              </FormRow>
              <FormRow label={discountType === "percent" ? "Discount (%)" : "Discount amount ($)"}>
                <Input
                  type="number"
                  min={0}
                  max={discountType === "percent" ? 100 : undefined}
                  value={discountValue}
                  disabled={!editableDiscount}
                  onChange={(e) => onDiscountValueChange?.(e.target.value)}
                  placeholder={discountType === "percent" ? "10" : "25"}
                />
              </FormRow>
              <FormRow label="Reason for discount *" className="sm:col-span-2">
                <Textarea
                  rows={2}
                  value={discountReason}
                  disabled={!editableDiscount}
                  onChange={(e) => onDiscountReasonChange?.(e.target.value)}
                  placeholder="e.g. Loyal client, staff family, promotional offer…"
                />
                {editableDiscount && reasonMissing && (
                  <p className="mt-1 text-xs text-rose-600">
                    A reason is required when a discount is applied.
                  </p>
                )}
              </FormRow>
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-slate-400">{emptyText}</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700">{item.label}</p>
                    {item.detail && <p className="mt-0.5 text-xs text-slate-400">{item.detail}</p>}
                    {editable && onItemQuantityChange && !item.covered && !item.lockQuantity ? (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={(e) =>
                            onItemQuantityChange(
                              item.id,
                              Math.max(1, Math.floor(Number(e.target.value) || 1)),
                            )
                          }
                          className="w-14 rounded-md border border-slate-200 px-1.5 py-1 text-xs text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
                          aria-label={`Quantity for ${item.label}`}
                        />
                        <span>× {formatMoney(item.unitPrice, item.currency)}</span>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">
                        {item.quantity} × {formatMoney(item.unitPrice, item.currency)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <p className="text-sm font-semibold text-slate-800">
                      {item.covered
                        ? "Package"
                        : formatMoney(item.unitPrice * item.quantity, item.currency)}
                    </p>
                    {onRemoveItem && (editable || item.removable) && !item.lockRemove && (
                      <button
                        type="button"
                        onClick={() => onRemoveItem(item.id)}
                        className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        aria-label={`Remove ${item.label}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {editable && addControl}

        {items.length > 0 && (
          <div className="space-y-2 border-t border-slate-100 pt-3 text-sm">
            <Row label="Subtotal" value={formatMoney(subtotal, currency)} />
            {discountOpen && discount > 0 && (
              <>
                <Row label="Discount" value={`-${formatMoney(discount, currency)}`} />
                {discountReason.trim() && (
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-slate-400">Reason</span>
                    <span className="text-right font-medium text-slate-700">
                      {discountReason.trim()}
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Final price
              </span>
              <span className="text-lg font-semibold text-slate-800">
                {formatMoney(total, currency)}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Package-covered sessions stay in the basket for tracking but do not add to the total.
            </p>
          </div>
        )}

        {footer}
      </CardBody>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}
