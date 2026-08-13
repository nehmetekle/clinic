"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FormRow, Input, MoneyInput, Select } from "@/components/ui/Field";
import { VisitBasketCard } from "@/components/VisitBasketCard";
import { api, StaleFxRateError } from "@/lib/api";
import { CLINIC } from "@/lib/config";
import {
  TENDER_CURRENCY_LABELS,
  TENDER_CURRENCY_VALUES,
  formatFxRate,
  formatTender,
  formatUsd as formatMoney2,
  fxRateFor,
  round2,
  settlementToleranceUsd,
  tenderToUsd,
  usdToTender,
  type FxRates,
  type TenderCurrency,
} from "@/lib/money";
import { useToast } from "@/lib/toast";
import {
  basketTotals,
  cardSurchargeAmount,
  formatDate,
  formatMoney,
  mergeAddedBasketItem,
  parseNumberInput,
} from "@/lib/utils";
import { useApi } from "@/lib/use-api";
import {
  JESSY_METHOD,
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
  // Kept so a "product" line's catalog link survives the edit — settlement
  // deducts inventory by the final settled quantity per product.
  productId?: string;
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
  // Live preview of the clinic's configured card fee, added on top of whatever a
  // card row collects — mirrors what settleVisitBasket actually charges server-side.
  const settings = useApi(() => api.getSettings());
  const surchargeRate = settings.data?.cardSurchargePercent ?? 0;

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
      productId: i.productId,
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
  // Payment method and tender CURRENCY are independent dimensions: "Cash / USD"
  // and "Cash / EUR" are two legitimate rows of one settlement, not a duplicate.
  // Amounts are typed in each row's own currency; the USD equivalent shown beside
  // it (and enforced by the server) is derived from the admin-set rate.
  const [splits, setSplits] = useState<
    { method: PaymentMethod; currency: TenderCurrency; amount: string }[]
  >([{ method: "cash", currency: "USD", amount: "" }]);
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
  // Set when a submit was rejected because an FX rate moved mid-checkout. Cleared
  // as soon as the desk edits anything, so it can never linger over a screen that
  // has already been re-priced and re-checked.
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
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
  //
  // A session-plan line is locked unconditionally, sent or not: a plan is paid
  // upfront in full, so part-paying one here would silently push the rest onto a
  // future visit. The server refuses any change to a plan line as well
  // (updateVisitBasket) — this only keeps the field from inviting the attempt.
  const isLockedQuantity = (i: EditItem) => i.sent || Boolean(i.sessionPlanId);

  // Only lines the secretary added here (sent === false) can be removed. Every
  // dietitian-sent line is guarded at the handler too, not just hidden in the
  // card, so the removal path stays wired but can never drop a sent line.
  function removeItem(key: string) {
    setItems((prev) => prev.filter((i) => !(i.key === key && !i.sent && !i.sessionPlanId)));
  }

  // Change an added line's quantity in place (a product the secretary rang up at
  // checkout). The card, subtotal and recorded payment all follow. Guarded at the
  // handler too, not just hidden in the card, so a locked line — anything the
  // dietitian sent, and every session-plan line — can never be retyped.
  function updateItemQuantity(key: string, quantity: number) {
    setItems((prev) =>
      prev.map((i) =>
        i.key === key && !isLockedQuantity(i)
          ? { ...i, quantity: Math.max(1, Math.floor(quantity)) }
          : i,
      ),
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
      productId: product.id,
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
        productId: i.productId,
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
  // `outstandingAmount` is the principal MINUS anything already collected against
  // it — the same figure settleVisitBasket folds server-side, so the preview and
  // the enforced total agree on a part-paid debt instead of over-collecting it.
  const debtTotalUsd = outstandingDebts.reduce((sum, d) => sum + d.outstandingAmount, 0);
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
  // the payment legs must add up to — same figure the server re-derives and
  // enforces. A $0 result (fully deferred/covered) collects nothing, so no split.
  const collectedNow = Math.max(0, round2(combinedTotalUsd - debtValue));

  // Live admin-controlled rates. These drive the PREVIEW only — the server resolves
  // them again from Settings when it settles, and its figures are authoritative.
  // The preview and the server share the very same conversion helpers, so the two
  // can only disagree if the rate itself changed between preview and submit, which
  // the server's own tolerance check would then reject rather than silently accept.
  const fxRates: FxRates = {
    usdToLbp: settings.data?.usdToLbp ?? CLINIC.defaultUsdToLbp,
    usdToEur: settings.data?.usdToEur ?? CLINIC.defaultUsdToEur,
  };
  /** Rate for a row's currency, or null when it isn't usable (never guessed). */
  function rateOrNull(currency: TenderCurrency): number | null {
    try {
      return fxRateFor(currency, fxRates);
    } catch {
      return null;
    }
  }
  /** USD value of a typed native amount; 0 when the rate is unusable. */
  function legUsd(currency: TenderCurrency, native: number): number {
    const rate = rateOrNull(currency);
    if (rate === null) return 0;
    return tenderToUsd(Math.max(0, native), currency, rate);
  }
  const unusableRate = splits.some((r) => rateOrNull(r.currency) === null);

  // All rows except the last are manual entries; the last row auto-absorbs the
  // remainder — now IN ITS OWN CURRENCY, so choosing EUR on the balancer shows the
  // euros to physically collect rather than a dollar figure the desk must convert.
  // So the split always sums to collectedNow; the only invalid state is
  // over-allocation (an earlier row pushes the remainder negative), which blocks
  // settlement, mirroring the debt-cap block.
  const enteredBeforeLast = splits
    .slice(0, -1)
    .reduce((s, r) => s + legUsd(r.currency, parseNumberInput(r.amount)), 0);
  const remainingUsd = round2(collectedNow - enteredBeforeLast);
  const balancer = splits[splits.length - 1];
  const balancerRate = balancer ? rateOrNull(balancer.currency) : null;
  // The native amount the balancer row must collect to cover `remainingUsd`.
  const balancerNative =
    balancer && balancerRate !== null && remainingUsd > 0
      ? usdToTender(remainingUsd, balancer.currency, balancerRate)
      : 0;
  const splitOverAllocated = collectedNow > 0 && remainingUsd < -0.005;

  // Payload: NATIVE amounts per row (the server converts). The last row carries the
  // balancing native amount; nothing is sent when $0 is collected.
  const effectiveSplits =
    collectedNow > 0
      ? splits.map((r, i) => ({
          method: r.method,
          currency: r.currency,
          amount:
            i === splits.length - 1
              ? Math.max(0, balancerNative)
              : Math.max(0, parseNumberInput(r.amount)),
        }))
      : [];
  // USD value of each row as the server will compute it — shown beside the native
  // amount so the desk never needs a calculator, and used for the running total.
  const splitUsd = effectiveSplits.map((s) => legUsd(s.currency, s.amount));
  const paidUsd = round2(splitUsd.reduce((s, a) => s + a, 0));
  // Residual after rounding each conversion to the cent. Mirrors the server's own
  // per-converted-leg allowance exactly, so a preview that reads "settled" cannot
  // be rejected on submit (and vice versa).
  const settlementTolerance = settlementToleranceUsd(effectiveSplits);
  const outstandingUsd = round2(collectedNow - paidUsd);
  const fullyCovered = collectedNow <= 0 || Math.abs(outstandingUsd) <= settlementTolerance;

  // Card fee on top of each row's entered (pre-surcharge) portion, in that row's
  // OWN currency — display only, and matching how the server charges it (natively,
  // a single rounding). The split itself always sums to collectedNow.
  const splitSurcharges = effectiveSplits.map((s) =>
    cardSurchargeAmount(s.amount, s.method, surchargeRate),
  );
  const totalCardSurchargeUsd = round2(
    splitSurcharges.reduce((sum, fee, i) => sum + legUsd(effectiveSplits[i].currency, fee), 0),
  );
  // A leg is identified by method AND currency, so "Cash / USD" plus "Cash / EUR"
  // is a valid pair — only an exact duplicate of both is blocked.
  const usedLegs = new Set(splits.map((r) => `${r.method}|${r.currency}`));
  const canAddMethod =
    collectedNow > 0 &&
    splits.length < PAYMENT_METHOD_VALUES.length * TENDER_CURRENCY_VALUES.length &&
    remainingUsd > 0.005;

  /** Jessy's receivable ledger is USD-only — the server rejects any other
   * currency on a jessy leg, so the picker must not offer one either. */
  function currenciesFor(method: PaymentMethod): readonly TenderCurrency[] {
    return method === JESSY_METHOD ? (["USD"] as const) : TENDER_CURRENCY_VALUES;
  }

  function updateSplit(
    idx: number,
    patch: Partial<{ method: PaymentMethod; currency: TenderCurrency; amount: string }>,
  ) {
    setStaleNotice(null);
    setSplits((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch };
        // Switching a row to Jessy forces it back to USD rather than submitting a
        // combination the server will refuse.
        if (next.method === JESSY_METHOD) next.currency = "USD";
        return next;
      }),
    );
  }
  function addSplit() {
    const next = PAYMENT_METHOD_VALUES.flatMap((m) =>
      currenciesFor(m).map((c) => ({ method: m, currency: c })),
    ).find((l) => !usedLegs.has(`${l.method}|${l.currency}`));
    if (!next) return;
    setSplits((prev) => [...prev, { ...next, amount: "" }]);
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
      toast(`The payment split exceeds the ${formatMoney2(collectedNow)} to collect.`);
      return;
    }
    // A leg whose rate is unusable would be valued at $0 in this preview while the
    // server refuses it outright — stop here so the desk gets the real reason.
    if (unusableRate) {
      toast("An exchange rate is missing or invalid — set it in Pricing before collecting.");
      return;
    }
    if (!fullyCovered) {
      toast(
        `The payment adds up to ${formatMoney2(paidUsd)} of the ${formatMoney2(collectedNow)} being collected.`,
      );
      return;
    }
    setSaving(true);
    try {
      // Persist any edits first so the recorded payment matches what's shown.
      await api.updateVisitBasket(basket.id, payload());
      await api.settleVisitBasket(basket.id, {
        splits: effectiveSplits,
        // The rates this screen priced the foreign legs at. Advisory: the server
        // uses its OWN rates to value everything and compares these only so that a
        // rate changed mid-checkout is reported as exactly that.
        expectedRates: { EUR: fxRates.usdToEur, LBP: fxRates.usdToLbp },
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
      // A rate moved between this screen opening and submitting. Nothing was
      // charged. Pull the new rates in so the amounts on screen re-price
      // themselves, and tell the desk plainly what happened.
      if (e instanceof StaleFxRateError) {
        await settings.refetch();
        setStaleNotice(e.message);
        toast("The exchange rate changed — amounts have been updated, please review.");
      } else {
        toast((e as Error).message);
      }
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
            <Button
              onClick={markPaid}
              disabled={
                saving ||
                discountReasonMissing ||
                debtReasonMissing ||
                splitOverAllocated ||
                unusableRate ||
                !fullyCovered
              }
            >
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
            <div className="flex items-start justify-between gap-3">
              <span>
                Settled{basket.paidAt ? ` on ${formatDate(basket.paidAt)}` : ""}
                {basket.receiptNumber ? ` · receipt ${basket.receiptNumber}` : ""}.
              </span>
              {/* One receipt covers the WHOLE settlement, however many legs it
                  had — the server rebuilds it from every payment sharing this
                  basket. A real link so the browser's PDF viewer owns the print
                  dialog, matching the Food List convention. */}
              {basket.paymentId && (
                <a
                  href={api.receiptPrintUrl(basket.paymentId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 font-medium text-emerald-800 underline hover:text-emerald-900"
                >
                  Print receipt
                </a>
              )}
            </div>
            {/* Shown for a split settlement, and for ANY settlement that took
                foreign currency — a single €200 leg needs its native amount and
                the rate it was banked at just as much as a split does. Rates come
                from the payment rows themselves, so this never moves. */}
            {basket.paymentSplits &&
              (basket.paymentSplits.length > 1 ||
                basket.paymentSplits.some((s) => s.currency !== "USD")) && (
                <ul className="mt-1 space-y-0.5 border-t border-emerald-200 pt-1 text-xs text-emerald-700">
                  {basket.paymentSplits.map((s) => (
                    <li key={s.receiptNumber} className="flex justify-between gap-3">
                      <span>
                        {PAYMENT_METHOD_LABELS[s.method] ?? s.method} · {s.receiptNumber}
                      </span>
                      <span className="text-right">
                        <span className="font-semibold">{formatTender(s.nativeAmount, s.currency)}</span>
                        {s.currency !== "USD" && (
                          <span className="block text-[11px] text-emerald-600">
                            ≈ {formatMoney2(s.amount)} · {formatFxRate(s.currency, s.fxRate)}
                          </span>
                        )}
                      </span>
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
            // (products/custom) stay editable and removable. Session-plan lines
            // are locked on both counts regardless — they're paid upfront in full.
            lockQuantity: isLockedQuantity(i),
            lockRemove: i.sent || Boolean(i.sessionPlanId),
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
                  <span className="whitespace-nowrap">{formatMoney2(d.outstandingAmount)}</span>
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
                // Legs free to pick in this row: any method whose (method,currency)
                // pair isn't already taken, plus this row's own.
                const options = PAYMENT_METHOD_VALUES.filter(
                  (m) =>
                    m === row.method ||
                    currenciesFor(m).some((c) => !usedLegs.has(`${m}|${c}`)),
                );
                const rowRate = rateOrNull(row.currency);
                const rowNative = effectiveSplits[idx]?.amount ?? 0;
                const rowUsd = splitUsd[idx] ?? 0;
                const rowSurcharge = splitSurcharges[idx] ?? 0;
                return (
                  <div key={idx}>
                    <div className="flex items-end gap-2">
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
                      <FormRow label={idx === 0 ? "Currency" : ""} className="w-28">
                        <Select
                          value={row.currency}
                          disabled={row.method === JESSY_METHOD}
                          onChange={(e) =>
                            updateSplit(idx, { currency: e.target.value as TenderCurrency })
                          }
                        >
                          {currenciesFor(row.method).map((c) => (
                            <option
                              key={c}
                              value={c}
                              // Same method AND same currency is a true duplicate.
                              disabled={c !== row.currency && usedLegs.has(`${row.method}|${c}`)}
                            >
                              {TENDER_CURRENCY_LABELS[c]}
                            </option>
                          ))}
                        </Select>
                      </FormRow>
                      <FormRow label={idx === 0 ? "Amount" : ""} className="w-36">
                        {isBalancer ? (
                          // Auto-balancer: shows what still has to be collected,
                          // converted into THIS row's currency, so the desk is told
                          // the euros/lira to take rather than a dollar figure.
                          // Read-only — the secretary types the other rows.
                          <div
                            className={`flex h-10 items-center justify-end rounded-lg border px-3 text-sm font-semibold ${
                              splitOverAllocated
                                ? "border-rose-300 bg-rose-50 text-rose-700"
                                : "border-slate-200 bg-slate-50 text-slate-700"
                            }`}
                          >
                            {rowRate === null ? "—" : formatTender(rowNative, row.currency)}
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
                          aria-label="Remove payment leg"
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="w-[52px]" />
                      )}
                    </div>
                    {row.currency !== "USD" && (
                      <div className="mt-1 flex items-center justify-end gap-2 pr-[52px] text-xs">
                        {rowRate === null ? (
                          <span className="font-medium text-rose-600">
                            No usable {row.currency} rate — set one in Pricing before collecting.
                          </span>
                        ) : (
                          <>
                            <span className="font-semibold text-slate-700">
                              ≈ {formatMoney2(rowUsd)}
                            </span>
                            <span className="text-slate-400">{formatFxRate(row.currency, rowRate)}</span>
                          </>
                        )}
                      </div>
                    )}
                    {rowSurcharge > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                        <span className="font-medium">Card fee {surchargeRate}%</span>
                        <span>+{formatTender(rowSurcharge, row.currency)}</span>
                        <span className="text-amber-400">→</span>
                        <span className="font-semibold">
                          {formatTender(rowNative + rowSurcharge, row.currency)} charged
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Bill total only. The running "paid"/"remaining" pair was dropped as
                redundant: the last row auto-absorbs the balance, so a correctly
                filled screen always reads $0 remaining, and the two extra lines
                added noise to what is normally a one-row USD settlement. The
                per-row "≈ $x" still gives the desk everything it needs to
                reconcile, and the server remains the authority either way. */}
            <div className="mt-3 flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-500">Bill total</span>
              <span className="font-medium text-slate-700">{formatMoney2(collectedNow)}</span>
            </div>
            {staleNotice && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {staleNotice}
              </p>
            )}
            {totalCardSurchargeUsd > 0 && (
              <div className="mt-3 flex items-center justify-between rounded-md bg-amber-50 px-3 py-2 text-sm">
                <span className="text-amber-800">
                  Card fee{splitSurcharges.filter((s) => s > 0).length > 1 ? "s" : ""} added
                </span>
                <span className="font-semibold text-amber-900">
                  +{formatMoney2(totalCardSurchargeUsd)} → {formatMoney2(collectedNow + totalCardSurchargeUsd)} total
                </span>
              </div>
            )}
            {splitOverAllocated ? (
              <p className="mt-2 text-xs text-rose-600">
                The split adds up to more than the {formatMoney2(collectedNow)} being collected — reduce an amount.
              </p>
            ) : (
              canAddMethod && (
                <button
                  type="button"
                  onClick={addSplit}
                  className="mt-2 text-sm font-medium text-brand-700 hover:underline"
                >
                  + Split across another method or currency
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
