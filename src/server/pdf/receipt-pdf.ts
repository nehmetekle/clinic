import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { formatFxRate, formatTender, formatUsd } from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import type { PaymentMethod } from "@/lib/types";
import type { ReceiptData } from "@/server/repositories/receipts";

/**
 * The printable payment receipt.
 *
 * Drawn with `pdf-lib` for the same reason the Food List is (Vercel has no
 * headless browser), and sharing that renderer's brand assets — but deliberately
 * NOT sharing its code: the Food List is a pixel-faithful reproduction of a paper
 * form whose layout must never move, and coupling a receipt's layout to it would
 * put that regression guarantee at risk for no benefit.
 *
 * Two rules this file exists to keep:
 *  1. Every figure comes from `ReceiptData`, which is built from persisted
 *     payment rows at their own frozen rates. Nothing here reads Settings, so a
 *     reprint years later reproduces the original figures exactly.
 *  2. A USD-only receipt shows no FX at all. The rate/equivalent lines appear
 *     per-leg, only for the legs that actually needed converting.
 */

// ---- Page geometry (A5 portrait — a receipt, not a letter) ----
const PT = 72;
const PAGE_W = 5.83 * PT * 1.0;
const PAGE_H = 8.27 * PT * 1.0;
const MARGIN = 34;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Palette reused from the Food List so the two documents read as one clinic.
const TEAL_BAND = hex("2F5F5C");
const TEAL_TEXT = hex("2E6666");
const INK = hex("273D3C");
const MUTED = hex("6B7A79");
const RULE = hex("D5DEDD");
const WHITE = rgb(1, 1, 1);

function hex(h: string): RGB {
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const ASSET_DIR = path.join(process.cwd(), "src", "server", "pdf");

type ReceiptAssets = { wordmark: Buffer };
let assetsPromise: Promise<ReceiptAssets> | null = null;

/** Read once per process — a cold start pays for this, not every reprint. */
function loadAssets(): Promise<ReceiptAssets> {
  if (!assetsPromise) {
    assetsPromise = readFile(path.join(ASSET_DIR, "assets", "layaka-wordmark-white.png")).then(
      (wordmark) => ({ wordmark }),
    );
  }
  return assetsPromise;
}

/** A cursor that walks down the page, so sections don't need absolute coordinates. */
class Cursor {
  y: number;
  constructor(top: number) {
    this.y = top;
  }
  down(by: number) {
    this.y -= by;
    return this.y;
  }
}

type Fonts = { regular: PDFFont; bold: PDFFont };

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on any character outside
 * that set — a patient name in Arabic script, or a stray emoji in a motif, would
 * take the whole receipt down. Names are user data, so they are sanitised rather
 * than trusted: unsupported characters become "?" and the receipt still prints.
 */
function sanitize(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text) {
    try {
      font.widthOfTextAtSize(ch, 10);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function draw(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; font: PDFFont; size: number; color?: RGB },
) {
  page.drawText(sanitize(text, opts.font), {
    x: opts.x,
    y: opts.y,
    font: opts.font,
    size: opts.size,
    color: opts.color ?? INK,
  });
}

/** Right-aligns to `right`, which is how every money column on the receipt sits. */
function drawRight(
  page: PDFPage,
  text: string,
  opts: { right: number; y: number; font: PDFFont; size: number; color?: RGB },
) {
  const clean = sanitize(text, opts.font);
  const w = opts.font.widthOfTextAtSize(clean, opts.size);
  page.drawText(clean, {
    x: opts.right - w,
    y: opts.y,
    font: opts.font,
    size: opts.size,
    color: opts.color ?? INK,
  });
}

/** Truncates with an ellipsis so a long item label can never overrun its column. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const clean = sanitize(text, font);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let cut = clean;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

function hr(page: PDFPage, y: number, color: RGB = RULE) {
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 0.75, color });
}

/** "13 Aug 2026, 14:05" in the CLINIC's timezone — the same clock the desk reads. */
function receiptTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.NEXT_PUBLIC_CLINIC_TIMEZONE || "Asia/Beirut",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export async function renderReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const { wordmark } = await loadAssets();
  const pdf = await PDFDocument.create();

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const logo = await pdf.embedPng(wordmark);

  pdf.setTitle(`Receipt ${data.receiptNumber}`);
  pdf.setSubject("Payment receipt");
  pdf.setProducer("NutriClinic");
  pdf.setCreator("NutriClinic");

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: WHITE });

  const c = new Cursor(PAGE_H);
  drawHeader(page, c, data, fonts, logo);
  drawMeta(page, c, data, fonts);
  if (data.items.length > 0) drawItems(page, c, data, fonts);
  drawDue(page, c, data, fonts);
  drawTender(page, c, data, fonts);
  drawTotals(page, c, data, fonts);
  drawFooter(page, data, fonts);

  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------- header

function drawHeader(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts, logo: PDFImage) {
  const bandH = 74;
  page.drawRectangle({ x: 0, y: PAGE_H - bandH, width: PAGE_W, height: bandH, color: TEAL_BAND });

  const logoW = 132;
  const logoH = (logo.height / logo.width) * logoW;
  page.drawImage(logo, {
    x: MARGIN,
    y: PAGE_H - bandH / 2 - logoH / 2 + 6,
    width: logoW,
    height: logoH,
  });

  drawRight(page, "RECEIPT", {
    right: PAGE_W - MARGIN,
    y: PAGE_H - 34,
    font: f.bold,
    size: 15,
    color: WHITE,
  });
  drawRight(page, data.receiptNumber, {
    right: PAGE_W - MARGIN,
    y: PAGE_H - 50,
    font: f.regular,
    size: 10,
    color: WHITE,
  });
  c.y = PAGE_H - bandH - 24;
}

// ------------------------------------------------------------------ meta

function drawMeta(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts) {
  const rows: [string, string][] = [["Date", receiptTimestamp(data.issuedAt)]];
  if (data.clientName) rows.push(["Patient", data.clientName]);
  if (data.visitNumber !== undefined) rows.push(["Visit", `#${data.visitNumber}`]);

  for (const [label, value] of rows) {
    draw(page, label, { x: MARGIN, y: c.y, font: f.regular, size: 9, color: MUTED });
    drawRight(page, fit(value, f.bold, 10, CONTENT_W - 90), {
      right: PAGE_W - MARGIN,
      y: c.y - 0.5,
      font: f.bold,
      size: 10,
    });
    c.down(15);
  }
  c.down(6);
  hr(page, c.y);
  c.down(18);
}

// ----------------------------------------------------------------- items

function drawItems(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts) {
  draw(page, "ITEMS", { x: MARGIN, y: c.y, font: f.bold, size: 8, color: MUTED });
  c.down(14);

  for (const item of data.items) {
    const qty = item.quantity > 1 ? ` ×${item.quantity}` : "";
    const label = fit(`${item.label}${qty}`, f.regular, 9.5, CONTENT_W - 80);
    draw(page, label, { x: MARGIN, y: c.y, font: f.regular, size: 9.5 });
    // A package/plan-covered line is shown so the patient can see what they
    // received, but it is charged at nothing — printing a price would imply a
    // second charge for something already paid for.
    drawRight(page, item.covered ? "covered" : lineAmount(item), {
      right: PAGE_W - MARGIN,
      y: c.y,
      font: f.regular,
      size: 9.5,
      color: item.covered ? MUTED : INK,
    });
    c.down(13);
  }

  if (data.discountUsd > 0) {
    draw(page, "Discount", { x: MARGIN, y: c.y, font: f.regular, size: 9.5, color: MUTED });
    drawRight(page, `− ${formatUsd(data.discountUsd)}`, {
      right: PAGE_W - MARGIN,
      y: c.y,
      font: f.regular,
      size: 9.5,
      color: MUTED,
    });
    c.down(13);
  }
  c.down(4);
  hr(page, c.y);
  c.down(18);
}

/** An item's own price, in the currency it was PRICED in (an obligation currency). */
function lineAmount(item: { quantity: number; unitPrice: number; currency: string }): string {
  const total = Math.round(item.unitPrice * item.quantity * 100) / 100;
  return item.currency === "LBP"
    ? `LBP ${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : formatUsd(total);
}

// ------------------------------------------------------------------- due

function drawDue(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts) {
  draw(page, data.dueLabel, { x: MARGIN, y: c.y, font: f.bold, size: 11, color: TEAL_TEXT });
  drawRight(page, formatUsd(data.dueUsd), {
    right: PAGE_W - MARGIN,
    y: c.y,
    font: f.bold,
    size: 13,
    color: TEAL_TEXT,
  });
  c.down(24);
}

// ---------------------------------------------------------------- tender

function drawTender(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts) {
  draw(page, data.tender.length > 1 ? "PAYMENTS" : "PAYMENT", {
    x: MARGIN,
    y: c.y,
    font: f.bold,
    size: 8,
    color: MUTED,
  });
  c.down(15);

  for (const t of data.tender) {
    const method = PAYMENT_METHOD_LABELS[t.method as PaymentMethod] ?? t.method;
    draw(page, method, { x: MARGIN, y: c.y, font: f.bold, size: 10 });
    // The NATIVE amount is the headline on every line — it is what the patient
    // actually handed over, and the only figure they can verify from memory.
    drawRight(page, formatTender(t.nativeAmount, t.currency), {
      right: PAGE_W - MARGIN,
      y: c.y,
      font: f.bold,
      size: 10,
    });
    c.down(12);

    // FX detail only where there was FX. A USD receipt stays a plain USD receipt.
    if (t.currency !== "USD") {
      draw(page, `Equivalent at settlement: ${formatUsd(t.usdEquivalent)}`, {
        x: MARGIN + 10,
        y: c.y,
        font: f.regular,
        size: 8.5,
        color: MUTED,
      });
      c.down(10.5);
      draw(page, `Rate: ${formatFxRate(t.currency, t.fxRate)}`, {
        x: MARGIN + 10,
        y: c.y,
        font: f.regular,
        size: 8.5,
        color: MUTED,
      });
      c.down(10.5);
    }

    if (t.cardSurchargeAmount > 0) {
      draw(page, `Card fee: ${formatTender(t.cardSurchargeAmount, t.currency)}`, {
        x: MARGIN + 10,
        y: c.y,
        font: f.regular,
        size: 8.5,
        color: MUTED,
      });
      c.down(10.5);
    }

    draw(page, t.receiptNumber, {
      x: MARGIN + 10,
      y: c.y,
      font: f.regular,
      size: 8,
      color: MUTED,
    });
    c.down(16);
  }

  hr(page, c.y);
  c.down(18);
}

// ---------------------------------------------------------------- totals

function drawTotals(page: PDFPage, c: Cursor, data: ReceiptData, f: Fonts) {
  // The label names the USD equivalence only when something needed converting,
  // so a USD-only receipt reads "Total paid" rather than accounting jargon.
  const paidLabel = data.hasForeignTender ? "Total USD-equivalent paid" : "Total paid";
  draw(page, paidLabel, { x: MARGIN, y: c.y, font: f.bold, size: 10 });
  drawRight(page, formatUsd(data.paidUsd), {
    right: PAGE_W - MARGIN,
    y: c.y,
    font: f.bold,
    size: 11,
  });
  c.down(15);

  if (data.totalCardSurchargeUsd > 0) {
    draw(page, "…of which card fees", { x: MARGIN, y: c.y, font: f.regular, size: 8.5, color: MUTED });
    drawRight(page, formatUsd(data.totalCardSurchargeUsd), {
      right: PAGE_W - MARGIN,
      y: c.y,
      font: f.regular,
      size: 8.5,
      color: MUTED,
    });
    c.down(14);
  }

  draw(page, "Balance", { x: MARGIN, y: c.y, font: f.bold, size: 10 });
  drawRight(page, formatUsd(data.balanceUsd), {
    right: PAGE_W - MARGIN,
    y: c.y,
    font: f.bold,
    size: 11,
    color: data.balanceUsd > 0 ? hex("A15C00") : TEAL_TEXT,
  });
  c.down(20);

  if (data.hasForeignTender) {
    draw(
      page,
      "Foreign currency converted at the rate recorded with each payment.",
      { x: MARGIN, y: c.y, font: f.regular, size: 7.5, color: MUTED },
    );
    c.down(11);
  }
}

// ---------------------------------------------------------------- footer

function drawFooter(page: PDFPage, data: ReceiptData, f: Fonts) {
  const y = MARGIN;
  hr(page, y + 22);
  draw(page, data.clinicName, { x: MARGIN, y, font: f.bold, size: 8, color: MUTED });
  drawRight(page, "Thank you", {
    right: PAGE_W - MARGIN,
    y,
    font: f.regular,
    size: 8,
    color: MUTED,
  });
}
