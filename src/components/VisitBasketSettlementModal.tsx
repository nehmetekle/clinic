"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FormRow, Input, MoneyInput, Select } from "@/components/ui/Field";
import { VisitBasketCard } from "@/components/VisitBasketCard";
import { api } from "@/lib/api";
import { toUsd } from "@/lib/config";
import { useToast } from "@/lib/toast";
import {
  basketTotals,
  formatDate,
  formatMoney,
  mergeAddedBasketItem,
  parseNumberInput,
} from "@/lib/utils";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHOD_VALUES,
  type ClientDebt,
  type Currency,
  type PaymentMethod,
  type Product,
  type VisitBasket,
  type VisitBasketItemKind,
} from "@/lib/types";

type EditItem = {
  key: string;
  kind: VisitBasketItemKind;
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
  covered: boolean;
  // True for lines the dietitian sent (seeded from the basket); false for items
  // the secretary adds here. The secretary collects the dietitian's lines exactly
  // as sent — quantity is locked on sent lines and only editable on added ones.
  sent: boolean;
  // Kept so a pay-as-you-go session line's plan link survives the edit and its
  // settled quantity advances the plan at settlement.
  sessionPlanId?: string;
};

/**
 * The secretary opens a sent basket here to review it, add/remove the items the
 * client wants, then settle it. Reuses the dietitian's exact basket card. Once
 * paid it's read-only. `onChanged` lets the caller refetch after save/settle.
 */
export function VisitBasketSettlementModal({
  basket,
  products,
  outstandingDebts = [],
  canSettle,
  onClose,
  onChanged,
}: {
  basket: VisitBasket;
  products: Product[];
  // The client's existing outstanding debts, auto-suggested as a collectable line.
  outstandingDebts?: ClientDebt[];
  canSettle: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const paid = basket.status === "paid";
  const editable = canSettle && !paid;

  const [items, setItems] = useState<EditItem[]>(() =>
    basket.items.map((i, idx) => ({
      key: i.id ?? `seed-${idx}`,
      kind: i.kind,
      label: i.label,
      detail: i.detail,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      currency: i.currency,
      covered: i.covered,
      sent: true,
      sessionPlanId: i.sessionPlanId,
    })),
  );
  const [discountOpen, setDiscountOpen] = useState(Boolean(basket.discountType));
  const [discountType, setDiscountType] = useState<"percent" | "amount">(
    basket.discountType ?? "percent",
  );
  const [discountValue, setDiscountValue] = useState(
    basket.discountValue ? String(basket.discountValue) : "",
  );
  const [discountReason, setDiscountReason] = useState(basket.discountReason ?? "");
  // Payment split: how the collected money is tendered, across one or more methods.
  // The LAST row is the auto-balancer — it always shows/absorbs the remaining, so
  // the split adds up without manual math (enter $100 Cash → the next method shows
  // the rest). One row = an ordinary single-method settlement.
  const [splits, setSplits] = useState<{ method: PaymentMethod; amount: string }[]>([
    { method: "cash", amount: "" },
  ]);
  // Secretary override: record a still-owed remainder as a tracked debt (e.g. the
  // client can only pay part today). Off by default.
  const [debtOpen, setDebtOpen] = useState(false);
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const [debtAmount, setDebtAmount] = useState("");
  const [debtReason, setDebtReason] = useState("");
  const [addProductId, setAddProductId] = useState("");
  const [addProductQty, setAddProductQty] = useState("1");
  const [customLabel, setCustomLabel] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [customQty, setCustomQty] = useState("1");
  const [saving, setSaving] = useState(false);
  // The client's old balance is shown for awareness but is NOT collected by
  // default: the secretary must explicitly tick it. Opt-in (not opt-out) so that
  // forgetting it can never mark an unpaid debt as collected without payment.
  const hasOutstandingDebt = outstandingDebts.length > 0;
  const [includeDebt, setIncludeDebt] = useState(false);
  const collectDebt = hasOutstandingDebt && includeDebt;

  const toQty = (v: string) => Math.max(1, Math.floor(parseNumberInput(v) || 1));

  let keySeq = 0;
  const nextKey = () => `new-${Date.now()}-${keySeq++}`;

  // The secretary collects the dietitian's basket exactly as sent: quantity and
  // removal are both locked on every line the dietitian sent (blood tests,
  // treatments, products, and the consultation fee — which only the dietitian or
  // an admin may waive). Only the items the secretary adds here at checkout
  // (products/custom) stay editable and removable. Extra quantity is added as a
  // new line, not by re-typing a sent line's count.
  const isLockedQuantity = (i: EditItem) => i.sent;

  // Only lines the secretary added here (sent === false) can be removed. Every
  // dietitian-sent line is guarded at the handler too, not just hidden in the
  // card, so the removal path stays wired but can never drop a sent line.
  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => !(i.key === key && !i.sent)));
  }

  // Change a charged line's quantity in place — e.g. the client can only pay for
  // 3 of the 12 sessions today. The card, subtotal and recorded payment all follow.
  function updateItemQuantity(key: string, quantity: number) {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, quantity: Math.max(1, Math.floor(quantity)) } : i)),
    );
  }

  // Add a secretary line, merging into an existing added line for the same item
  // (same kind + label + unit price + currency) by bumping its quantity — so
  // adding the same product twice reads as one line ×2 instead of two duplicate
  // rows. The dietitian's sent lines are never merged into: they're collected
  // exactly as sent, so an add always lands as its own editable line beside them.
  function addOrMergeItem(item: Omit<EditItem, "key">) {
    setItems((prev) => mergeAddedBasketItem(prev, { ...item, key: nextKey() }));
  }

  function addProduct() {
    const product = products.find((p) => p.id === addProductId);
    if (!product) return;
    addOrMergeItem({
      kind: "product",
      label: product.name,
      detail: "Product · added at checkout",
      quantity: toQty(addProductQty),
      unitPrice: product.price,
      currency: product.currency,
      covered: false,
      sent: false,
    });
    setAddProductId("");
    setAddProductQty("1");
  }

  function addCustom() {
    const label = customLabel.trim();
    if (!label) return;
    addOrMergeItem({
      kind: "custom",
      label,
      detail: "Added at checkout",
      quantity: toQty(customQty),
      unitPrice: Math.max(0, parseNumberInput(customAmount)),
      currency: basket.currency,
      covered: false,
      sent: false,
    });
    setCustomLabel("");
    setCustomAmount("");
    setCustomQty("1");
  }

  function payload() {
    return {
      items: items.map((i) => ({
        kind: i.kind,
        label: i.label,
        detail: i.detail,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        currency: i.currency,
        covered: i.covered,
        sessionPlanId: i.sessionPlanId,
      })),
      discountType: discountOpen && Number(discountValue) > 0 ? discountType : null,
      discountValue: discountOpen ? Number(discountValue) || 0 : 0,
      discountReason:
        discountOpen && Number(discountValue) > 0 ? discountReason.trim() : null,
      currency: basket.currency,
    };
  }

  // A reason is mandatory once an actual discount amount is entered.
  const discountReasonMissing =
    discountOpen && (Number(discountValue) || 0) > 0 && !discountReason.trim();

  // A reason is mandatory once a debt amount is entered.
  const debtValue = debtOpen ? Math.max(0, parseNumberInput(debtAmount)) : 0;
  const debtReasonMissing = debtValue > 0 && !debtReason.trim();

  // Money source of truth is USD (see basketTotals). Old debt total + today's
  // (post-discount) total give the combined "to collect" figure the client owes.
  const debtTotalUsd = outstandingDebts.reduce(
    (sum, d) => sum + toUsd(d.amount, d.currency, d.usdToLbp),
    0,
  );
  const todayTotalUsd = basketTotals(
    items.map((i) => ({
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      covered: i.covered,
      currency: i.currency,
    })),
    {
      type: discountOpen && Number(discountValue) > 0 ? discountType : null,
      value: discountOpen ? Number(discountValue) || 0 : 0,
    },
    basket.usdToLbp || undefined,
  ).total;
  const combinedTotalUsd = todayTotalUsd + (collectDebt ? debtTotalUsd : 0);

  // The single amount actually collected now (USD): today's total + any old balance
  // being collected, minus the deferred remainder recorded as debt. This is what
  // the payment split must add up to — same figure the server re-derives and
  // enforces. A $0 result (fully deferred/covered) collects nothing, so no split.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const collectedNow = Math.max(0, round2(combinedTotalUsd - debtValue));
  // All rows except the last are manual entries; the last row auto-absorbs the
  // remainder. So the split always sums to collectedNow — the only invalid state is
  // over-allocation (an earlier row pushes the remainder negative), which blocks
  // settlement, mirroring the debt-cap block.
  const enteredBeforeLast = splits
    .slice(0, -1)
    .reduce((s, r) => s + Math.max(0, parseNumberInput(r.amount)), 0);
  const remaining = round2(collectedNow - enteredBeforeLast);
  const splitOverAllocated = collectedNow > 0 && remaining < -0.005;
  // Payload: the last row carries the remaining; nothing to send when $0 collected.
  const effectiveSplits =
    collectedNow > 0
      ? splits.map((r, i) => ({
          method: r.method,
          amount: i === splits.length - 1 ? Math.max(0, remaining) : Math.max(0, parseNumberInput(r.amount)),
        }))
      : [];
  const usedMethods = new Set(splits.map((r) => r.method));
  const canAddMethod =
    collectedNow > 0 && splits.length < PAYMENT_METHOD_VALUES.length && remaining > 0.005;

  function updateSplit(idx: number, patch: Partial<{ method: PaymentMethod; amount: string }>) {
    setSplits((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addSplit() {
    const next = PAYMENT_METHOD_VALUES.find((m) => !usedMethods.has(m));
    if (!next) return;
    setSplits((prev) => [...prev, { method: next, amount: "" }]);
  }
  function removeSplit(idx: number) {
    setSplits((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function saveChanges() {
    if (discountReasonMissing) {
      toast("Please add a reason for the discount.");
      return;
    }
    setSaving(true);
    try {
      await api.updateVisitBasket(basket.id, payload());
      toast("Basket updated");
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function markPaid() {
    if (discountReasonMissing) {
      toast("Please add a reason for the discount.");
      return;
    }
    if (debtReasonMissing) {
      toast("Please add a reason for the debt.");
      return;
    }
    if (splitOverAllocated) {
      toast(`The payment split exceeds the ${formatMoney(collectedNow, "USD")} to collect.`);
      return;
    }
    setSaving(true);
    try {
      // Persist any edits first so the recorded payment matches what's shown.
      await api.updateVisitBasket(basket.id, payload());
      await api.settleVisitBasket(basket.id, {
        splits: effectiveSplits,
        // Record a still-owed remainder as a tracked debt when the override is on.
        ...(debtValue > 0
          ? { debtAmount: debtValue, debtReason: debtReason.trim() }
          : {}),
        // Collect the client's chosen outstanding debt(s) in the same settlement.
        ...(collectDebt ? { clearDebtIds: outstandingDebts.map((d) => d.id) } : {}),
      });
      toast(
        collectDebt
          ? "Payment recorded — today's visit + outstanding balance settled"
          : debtValue > 0
            ? "Basket settled — remaining balance tracked as debt"
            : "Payment recorded — basket settled",
      );
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const activeProducts = products.filter((p) => p.active);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Visit basket — ${basket.clientName}`}
      footer={
        editable ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="outline" onClick={saveChanges} disabled={saving || discountReasonMissing}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button onClick={markPaid} disabled={saving || discountReasonMissing || debtReasonMissing || splitOverAllocated}>
              {saving ? "Saving…" : debtValue > 0 ? "Mark paid + record debt" : "Mark paid"}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {paid && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <div>
              Settled{basket.paidAt ? ` on ${formatDate(basket.paidAt)}` : ""}
              {basket.receiptNumber ? ` · receipt ${basket.receiptNumber}` : ""}.
            </div>
            {basket.paymentSplits && basket.paymentSplits.length > 1 && (
              <ul className="mt-1 space-y-0.5 border-t border-emerald-200 pt-1 text-xs text-emerald-700">
                {basket.paymentSplits.map((s) => (
                  <li key={s.receiptNumber} className="flex justify-between gap-3">
                    <span>{PAYMENT_METHOD_LABELS[s.method] ?? s.method} · {s.receiptNumber}</span>
                    <span className="font-semibold">{formatMoney(s.amount, "USD")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <VisitBasketCard
          subtitle={`Sent by ${basket.dietitianName}`}
          currency={basket.currency}
          usdToLbp={basket.usdToLbp}
          items={items.map((i) => ({
            id: i.key,
            label: i.label,
            detail: i.detail,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            currency: i.currency,
            covered: i.covered,
            // Secretary collects every line the dietitian sent exactly as sent:
            // no quantity edits and no removal. Only her own added lines
            // (products/custom) stay editable and removable.
            lockQuantity: isLockedQuantity(i),
            lockRemove: i.sent,
          }))}
          discountOpen={discountOpen}
          discountType={discountType}
          discountValue={discountValue}
          discountReason={discountReason}
          onToggleDiscount={editable ? setDiscountOpen : undefined}
          onDiscountTypeChange={editable ? setDiscountType : undefined}
          onDiscountValueChange={editable ? setDiscountValue : undefined}
          onDiscountReasonChange={editable ? setDiscountReason : undefined}
          editable={editable}
          onRemoveItem={removeItem}
          onItemQuantityChange={editable ? updateItemQuantity : undefined}
          emptyText="No items in this basket."
          addControl={
            <div className="space-y-3 rounded-lg border border-dashed border-slate-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Add an item
                </p>
                <Button
                  size="sm"
                  variant={addItemsOpen ? "ghost" : "outline"}
                  onClick={() => setAddItemsOpen((open) => !open)}
                  aria-expanded={addItemsOpen}
                >
                  {addItemsOpen ? "Hide" : <><Plus className="h-3.5 w-3.5" /> Add item</>}
                </Button>
              </div>
              {addItemsOpen && (
                <>
                  <div className="flex items-end gap-2">
                    <FormRow label="Product" className="flex-1">
                      <Select value={addProductId} onChange={(e) => setAddProductId(e.target.value)}>
                        <option value="">Select product…</option>
                        {activeProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {formatMoney(p.price, p.currency)}
                          </option>
                        ))}
                      </Select>
                    </FormRow>
                    <FormRow label="Qty" className="w-16">
                      <Input
                        type="number"
                        min={1}
                        value={addProductQty}
                        onChange={(e) => setAddProductQty(e.target.value)}
                      />
                    </FormRow>
                    <Button size="sm" variant="outline" onClick={addProduct} disabled={!addProductId}>
                      <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </div>
                  <div className="flex items-end gap-2">
                    <FormRow label="Custom item" className="flex-1">
                      <Input
                        value={customLabel}
                        onChange={(e) => setCustomLabel(e.target.value)}
                        placeholder="e.g. Consultation top-up"
                      />
                    </FormRow>
                    <FormRow label="Price">
                      <MoneyInput value={customAmount} onValueChange={setCustomAmount} placeholder="0" />
                    </FormRow>
                    <FormRow label="Qty" className="w-16">
                      <Input
                        type="number"
                        min={1}
                        value={customQty}
                        onChange={(e) => setCustomQty(e.target.value)}
                      />
                    </FormRow>
                    <Button size="sm" variant="outline" onClick={addCustom} disabled={!customLabel.trim()}>
                      <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </div>
                </>
              )}
            </div>
          }
        />

        {editable && hasOutstandingDebt && (
          <div
            className={`rounded-lg border p-3 ${
              collectDebt ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"
            }`}
          >
            {/* Shown for awareness, but collecting it is an explicit opt-in: the
                checkbox is OFF by default, so an untouched settlement never marks
                the client's old balance as collected. */}
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={includeDebt}
                  onChange={(e) => setIncludeDebt(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-amber-600"
                />
                <span>
                  <span className={`block text-sm font-semibold ${collectDebt ? "text-amber-900" : "text-slate-700"}`}>
                    Also collect outstanding balance from previous visits
                  </span>
                  <span className={`block text-xs ${collectDebt ? "text-amber-700" : "text-slate-500"}`}>
                    {collectDebt
                      ? `Added to today's payment — ${outstandingDebts.length} unpaid ${outstandingDebts.length === 1 ? "item" : "items"} will be marked collected`
                      : `${outstandingDebts.length} unpaid ${outstandingDebts.length === 1 ? "item" : "items"} · stays as debt unless you tick this`}
                  </span>
                </span>
              </span>
              <span className={`whitespace-nowrap text-sm font-semibold ${collectDebt ? "text-amber-900" : "text-slate-600"}`}>
                {formatMoney(debtTotalUsd, "USD")}
              </span>
            </label>
            <ul className={`mt-2 space-y-0.5 border-t pt-2 text-xs ${collectDebt ? "border-amber-200 text-amber-800" : "border-slate-200 text-slate-500"}`}>
              {outstandingDebts.map((d) => (
                <li key={d.id} className="flex justify-between gap-3">
                  <span className="truncate">{d.reason}</span>
                  <span className="whitespace-nowrap">{formatMoney(d.amount, d.currency)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {editable && collectDebt && (
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-600">Total to collect (today + balance)</span>
            <span className="font-semibold text-slate-900">{formatMoney(combinedTotalUsd, "USD")}</span>
          </div>
        )}

        {editable && collectedNow > 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Payment method{splits.length > 1 ? " — split" : ""}
              </p>
              <span className="text-xs text-slate-500">
                Collecting <span className="font-semibold text-slate-700">{formatMoney(collectedNow, "USD")}</span>
              </span>
            </div>
            <div className="space-y-2">
              {splits.map((row, idx) => {
                const isBalancer = idx === splits.length - 1;
                // Methods free to pick in this row: unused ones + this row's own.
                const options = PAYMENT_METHOD_VALUES.filter(
                  (m) => m === row.method || !usedMethods.has(m),
                );
                return (
                  <div key={idx} className="flex items-end gap-2">
                    <FormRow label={idx === 0 ? "Method" : ""} className="flex-1">
                      <Select
                        value={row.method}
                        onChange={(e) => updateSplit(idx, { method: e.target.value as PaymentMethod })}
                      >
                        {options.map((m) => (
                          <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                        ))}
                      </Select>
                    </FormRow>
                    <FormRow label={idx === 0 ? "Amount (USD)" : ""} className="w-32">
                      {isBalancer ? (
                        // Auto-balancer: shows the remaining so the split always
                        // adds up. Read-only — the secretary types the other rows.
                        <div
                          className={`flex h-10 items-center justify-end rounded-lg border px-3 text-sm font-semibold ${
                            splitOverAllocated
                              ? "border-rose-300 bg-rose-50 text-rose-700"
                              : "border-slate-200 bg-slate-50 text-slate-700"
                          }`}
                        >
                          {formatMoney(remaining, "USD")}
                        </div>
                      ) : (
                        <MoneyInput
                          value={row.amount}
                          onValueChange={(amount) => updateSplit(idx, { amount })}
                          placeholder="0"
                        />
                      )}
                    </FormRow>
                    {splits.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeSplit(idx)}
                        className="mb-1 px-1 text-xs text-slate-400 hover:text-rose-600"
                        aria-label="Remove method"
                      >
                        Remove
                      </button>
                    ) : (
                      <span className="w-[52px]" />
                    )}
                  </div>
                );
              })}
            </div>
            {splitOverAllocated ? (
              <p className="mt-2 text-xs text-rose-600">
                The split adds up to more than the {formatMoney(collectedNow, "USD")} being collected — reduce a method amount.
              </p>
            ) : (
              canAddMethod && (
                <button
                  type="button"
                  onClick={addSplit}
                  className="mt-2 text-sm font-medium text-brand-700 hover:underline"
                >
                  + Split across another method
                </button>
              )
            )}
          </div>
        )}

        {editable && collectedNow <= 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            Nothing to collect now{debtValue > 0 ? " (recorded as debt below)" : " (fully covered)"} — no payment method needed.
          </div>
        )}

        {editable && (
          <div className="rounded-lg border border-dashed border-slate-200 p-3">
            {!debtOpen ? (
              <button
                type="button"
                onClick={() => setDebtOpen(true)}
                className="text-sm font-medium text-brand-700 hover:underline"
              >
                + Client still owes a balance (record as debt)
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Record remaining balance as debt
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDebtOpen(false);
                      setDebtAmount("");
                      setDebtReason("");
                    }}
                    className="text-xs text-slate-400 hover:text-slate-600"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex items-end gap-2">
                  <FormRow label="Amount owed" className="w-32">
                    <MoneyInput value={debtAmount} onValueChange={setDebtAmount} placeholder="0" />
                  </FormRow>
                  <FormRow label="Reason" className="flex-1">
                    <Input
                      value={debtReason}
                      onChange={(e) => setDebtReason(e.target.value)}
                      placeholder="e.g. paid 3 of 5 sessions, rest next visit"
                    />
                  </FormRow>
                </div>
                <p className="text-xs text-slate-400">
                  The payment above is recorded for what was collected now; this amount is tracked
                  separately on the client&apos;s profile. Don&apos;t include session-plan sessions —
                  those are already tracked on the plan.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
