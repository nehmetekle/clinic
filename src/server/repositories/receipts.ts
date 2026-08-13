import { db } from "../db";
import { NotFoundError } from "../http";
import { CLINIC } from "@/lib/config";
import {
  frozenPaymentFxRate,
  round2,
  tenderToUsd,
  type TenderCurrency,
} from "@/lib/money";
import { basketTotals } from "@/lib/utils";
import type { PaymentMethod } from "@/lib/types";

/**
 * Receipt data — assembled ENTIRELY from persisted rows, never from Settings.
 *
 * A receipt is a projection, not a stored document: it is rebuilt on demand from
 * the `Payment` rows it describes, each of which carries its own native amount
 * and its own frozen `fxRate`. That is deliberately different from the Food List
 * PDF (which is stored and can go stale): a stored receipt would be a second
 * source of truth that could drift from the ledger, whereas one derived from the
 * payments themselves is guaranteed to agree with them and is structurally
 * incapable of re-pricing when an admin changes today's rate. Reprinting a
 * two-year-old receipt reproduces the original figures exactly.
 */
export type ReceiptTenderLine = {
  method: PaymentMethod;
  currency: TenderCurrency;
  /** What was physically handed over, in `currency`, net of any card surcharge. */
  nativeAmount: number;
  /** Units of `currency` per 1 USD, frozen on the payment when it was recorded. */
  fxRate: number;
  /** `nativeAmount / fxRate` at the frozen rate. Equals nativeAmount for USD. */
  usdEquivalent: number;
  /** Card fee charged on top, in `currency` (0 for every non-card leg). */
  cardSurchargeAmount: number;
  cardSurchargeUsd: number;
  receiptNumber: string;
};

export type ReceiptLineItem = {
  label: string;
  detail?: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  /** Covered by a package/plan credit: shown for completeness, charged at 0. */
  covered: boolean;
};

export type ReceiptData = {
  /** The primary receipt number — the first leg's. Every leg's number is listed. */
  receiptNumber: string;
  issuedAt: string;
  clinicName: string;
  clientName?: string;
  /** "Visit charges …" / "Debt settlement — …", straight off the payment. */
  motif: string;
  visitNumber?: number;
  /** What this receipt settles, in USD. Always USD — obligations never go foreign. */
  dueUsd: number;
  dueLabel: string;
  /** Basket lines, when the receipt covers a visit settlement. */
  items: ReceiptLineItem[];
  discountUsd: number;
  tender: ReceiptTenderLine[];
  paidUsd: number;
  /** `dueUsd - paidUsd`, floored at 0 — what is still owed on THIS obligation. */
  balanceUsd: number;
  totalCardSurchargeUsd: number;
  /** True when any leg was taken in a currency other than USD. Keeps a plain USD
   * receipt free of FX columns it does not need. */
  hasForeignTender: boolean;
};

const paymentSelect = {
  id: true,
  receiptNumber: true,
  motif: true,
  amountPaid: true,
  currency: true,
  usdToLbp: true,
  fxRate: true,
  cardSurchargeAmount: true,
  method: true,
  date: true,
  visitBasketId: true,
  client: { select: { firstName: true, lastName: true } },
} as const;

type PaymentRow = {
  receiptNumber: string;
  amountPaid: number;
  currency: string;
  usdToLbp: number;
  fxRate: number | null;
  cardSurchargeAmount: number;
  method: string;
};

/** One tender line, valued at the rate frozen on that payment — never today's. */
function toTenderLine(p: PaymentRow): ReceiptTenderLine {
  const { currency, fxRate } = frozenPaymentFxRate(p);
  // The receipt shows the charge and the fee separately, mirroring how the
  // settlement screen presented them: `amountPaid` includes the card surcharge.
  const net = round2(p.amountPaid - p.cardSurchargeAmount);
  return {
    method: p.method as PaymentMethod,
    currency,
    nativeAmount: net,
    fxRate,
    usdEquivalent: tenderToUsd(net, currency, fxRate),
    cardSurchargeAmount: p.cardSurchargeAmount,
    cardSurchargeUsd: tenderToUsd(p.cardSurchargeAmount, currency, fxRate),
    receiptNumber: p.receiptNumber,
  };
}

/**
 * Builds the receipt for the settlement a payment belongs to.
 *
 * A split settlement writes one `Payment` per method × currency leg, all sharing
 * a `visitBasketId`; passing ANY of them produces the same complete receipt for
 * the whole settlement, so the desk can print from whichever receipt number it
 * has to hand. A standalone payment (manual entry, debt collection) has no
 * basket and produces a single-leg receipt.
 */
export async function getReceiptData(paymentId: string): Promise<ReceiptData> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: paymentSelect,
  });
  if (!payment) throw new NotFoundError("Receipt not found");

  // Every leg of the same settlement. Ordered by receipt number so the printed
  // order is stable and matches the order they were recorded in.
  const legs = payment.visitBasketId
    ? await db.payment.findMany({
        where: { visitBasketId: payment.visitBasketId },
        select: paymentSelect,
        orderBy: { receiptNumber: "asc" },
      })
    : [payment];

  const tender = legs.map(toTenderLine);
  const paidUsd = round2(tender.reduce((s, t) => s + t.usdEquivalent, 0));
  const totalCardSurchargeUsd = round2(tender.reduce((s, t) => s + t.cardSurchargeUsd, 0));

  let items: ReceiptLineItem[] = [];
  let discountUsd = 0;
  let dueUsd = paidUsd;
  let dueLabel = "Amount due";
  let visitNumber: number | undefined;

  if (payment.visitBasketId) {
    const basket = await db.visitBasket.findUnique({
      where: { id: payment.visitBasketId },
      select: {
        discountType: true,
        discountValue: true,
        usdToLbp: true,
        consultation: { select: { visitNumber: true } },
        items: {
          select: {
            label: true,
            detail: true,
            quantity: true,
            unitPrice: true,
            currency: true,
            covered: true,
          },
        },
      },
    });
    if (basket) {
      // Re-derive the basket total through the SAME shared kernel the settlement
      // used (`basketTotals`), at the rate frozen on the basket — so the "total
      // due" printed here is the figure that was actually charged, not a
      // recomputation at today's rate.
      const totals = basketTotals(
        basket.items,
        {
          type: (basket.discountType ?? undefined) as "percent" | "amount" | undefined,
          value: basket.discountValue,
        },
        basket.usdToLbp > 0 ? basket.usdToLbp : CLINIC.defaultUsdToLbp,
      );
      items = basket.items.map((i) => ({
        label: i.label,
        detail: i.detail ?? undefined,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        currency: i.currency,
        covered: i.covered,
      }));
      discountUsd = totals.discount;
      dueUsd = totals.total;
      dueLabel = "Visit total";
      visitNumber = basket.consultation?.visitNumber ?? undefined;
    }
  } else {
    // Standalone payment (manual receipt, or a debt collection). There is no
    // basket to price, so what was due for THIS receipt is what it collected —
    // any wider debt balance is shown on the client's profile, not here, because
    // a receipt must describe the transaction it documents and nothing else.
    dueLabel = payment.motif.startsWith("Debt settlement") ? "Collected against debt" : "Amount due";
  }

  return {
    receiptNumber: payment.receiptNumber,
    issuedAt: payment.date.toISOString(),
    clinicName: CLINIC.name,
    clientName: payment.client
      ? `${payment.client.firstName} ${payment.client.lastName}`
      : undefined,
    motif: payment.motif,
    visitNumber,
    dueUsd,
    dueLabel,
    items,
    discountUsd,
    tender,
    paidUsd,
    balanceUsd: Math.max(0, round2(dueUsd - paidUsd)),
    totalCardSurchargeUsd,
    hasForeignTender: tender.some((t) => t.currency !== "USD"),
  };
}

/** Resolves a receipt NUMBER to its payment id, for printing from a receipt stub. */
export async function paymentIdByReceiptNumber(receiptNumber: string): Promise<string | null> {
  const row = await db.payment.findUnique({
    where: { receiptNumber },
    select: { id: true },
  });
  return row?.id ?? null;
}
