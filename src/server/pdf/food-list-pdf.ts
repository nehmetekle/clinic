import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import {
  FOOD_LIST_CATEGORIES,
  FOOD_LIST_FOOTER,
  FOOD_LIST_SPECIALITIES,
  FOOD_LIST_SUBTITLE,
  FOOD_LIST_TITLE,
} from "@/lib/food-list";

/**
 * Renders the Nutrient-Rich Foods List as a one-page PDF replicating Layaka's
 * paper form ("Patient paper english.docx").
 *
 * Why pdf-lib and not HTML→PDF: the source is a fixed single-page layout of
 * absolutely-positioned boxes, and the app deploys to Vercel (see vercel.json)
 * where a headless browser isn't practical. Every coordinate below was measured
 * off the .docx — the shape offsets/extents in word/document.xml, cross-checked
 * against a render of the original — so this is a transcription of the document's
 * real geometry, not an approximation of how it looks.
 *
 * Coordinates are expressed in INCHES FROM THE TOP-LEFT of a US Letter page
 * (matching how Word states them); `pt()`/`yFromTop()` convert to PDF's
 * bottom-left origin at the point of drawing.
 */

// ---- Page geometry (US Letter) ----
const IN = 72; // points per inch
const PAGE_W = 8.5 * IN;
const PAGE_H = 11 * IN;

const pt = (inches: number) => inches * IN;
const yFromTop = (inches: number) => PAGE_H - inches * IN;

// ---- Palette, verbatim from the document ----
const TEAL_BAND = hex("2F5F5C"); // header band fill
const TEAL_FOOTER = hex("2D6664"); // footer bar fill
const TEAL_TEXT = hex("2E6666"); // title, subtitle and category headings
const ITEM_TEXT = hex("273D3C"); // checkbox item labels
const BOX_BORDER = hex("0A111D"); // item box outline (theme accent1 @ 15% shade)
const RULE = hex("929292"); // the Name/Notes fill-in rules
const WHITE = rgb(1, 1, 1);

function hex(h: string): RGB {
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ---- Header band ----
// The teal band runs off the top of the page; a white rectangle in the document
// trims it at 1.5in, which is the visible edge reproduced here.
const BAND_BOTTOM = 1.5;
const LOGO = { x: 2.361, y: 0.114, w: 3.591, h: 0.923 };
const QR = { x: 6.925, y: 0.187, w: 0.827, h: 0.778 };
const SPECIALITIES_BASELINE = 1.28;
const SPECIALITIES_MAX_W = 7.9;
const SPECIALITIES_SEPARATOR = 5; // pt — the document's separator is 0.07in

// ---- Title block ----
const TITLE_CENTER_X = 4.245;
const TITLE_BASELINE = 1.79;
const SUBTITLE_BASELINE = 2.03;

// ---- Name / Notes rows ----
const FIELD_LABEL_X = 0.37;
const RULE_X0 = 1.31;
const RULE_X1 = 6.09;
const NAME_BASELINE = 10.05;
const NOTES_BASELINE = 10.35;

// ---- Footer bar ----
const FOOTER = { y: 10.62, h: 0.32 };
const FOOTER_BASELINE = 10.83;

// ---- Type sizes, from the document's run properties ----
const SZ_TITLE = 20; // Calibri Light bold  -> Carlito bold
const SZ_SUBTITLE = 12; // Lato bold
const SZ_HEADING = 16; // Calibri bold       -> Carlito bold
const SZ_ITEM = 12.5; // Calibri bold       -> Carlito bold
const SZ_FIELD = 16; // Calibri bold       -> Carlito bold
const SZ_FOOTER = 11; // Lato
const SZ_SPECIALITIES = 12; // Lato

// ---- Item layout inside a category box ----
// Word's text-box insets, read from each shape's <wps:bodyPr> (they're identical
// on every box): 0.1in left/right, 0.05in top/bottom. These are what keep the
// labels clear of the border — text is laid out inside box ± these insets, never
// against the edge.
const BOX_INSET_X = 0.1;
const BOX_INSET_Y = 0.05;
const CHECKBOX_SIZE = 8; // pt — matches the ☐ glyph's box at 12.5pt
const CHECKBOX_GAP = 4; // pt between the box and its label
const LEAF_SIZE = 0.2; // the leaf bullet is exactly 0.2in in the document

/**
 * Line spacing per category, as set on the paragraphs in the source document
 * (`<w:spacing w:line=…>`, /240 = the multiplier). It is genuinely NOT uniform —
 * the form was hand-built and different boxes were formatted differently, which
 * is why a single guessed pitch made some columns overflow their box and others
 * sit loose. Values here are read straight out of word/document.xml.
 */
const LINE_SPACING: Record<string, number> = {
  vegetables: 276 / 240, // 1.15
  fruits: 1, // single
  "nuts-and-seeds": 280 / 240, // ~1.167
  "animal-proteins": 1, // single
  "plant-based-proteins": 1, // single
  carbohydrates: 1, // single
  "eggs-and-dairy": 276 / 240, // 1.15
  "other-foods": 276 / 240, // 1.15
};

/**
 * Per-category geometry, measured from the source document: the outlined item box
 * and the position of its leaf-bulleted heading. The document places these by
 * hand — the small per-column variations in x are the original's, kept as-is.
 */
const CATEGORY_BOXES: Record<
  string,
  // `leafX` is where the heading's leaf bullet starts — in the document the leaf is
  // the first inline element of the heading run, so it sits at the heading box's
  // left inset and the text follows it. (Treating this as the TEXT position and
  // back-spacing the leaf shifts every heading left and pushes the "Nuts and seeds"
  // leaf over the Vegetables box border.)
  { box: { x: number; y: number; w: number; h: number }; leafX: number; headingBaseline: number }
> = {
  vegetables: { box: { x: 0.35, y: 2.5, w: 1.85, h: 7.05 }, leafX: 0.48, headingBaseline: 2.37 },
  fruits: { box: { x: 2.39, y: 2.52, w: 1.78, h: 5.32 }, leafX: 2.59, headingBaseline: 2.38 },
  "nuts-and-seeds": {
    box: { x: 2.39, y: 8.23, w: 1.78, h: 1.18 },
    leafX: 2.35,
    headingBaseline: 8.15,
  },
  "animal-proteins": {
    box: { x: 4.35, y: 2.51, w: 1.68, h: 2.23 },
    leafX: 4.29,
    headingBaseline: 2.39,
  },
  "plant-based-proteins": {
    box: { x: 4.41, y: 5.32, w: 1.62, h: 1.54 },
    leafX: 4.43,
    headingBaseline: 4.95,
  },
  carbohydrates: {
    box: { x: 4.41, y: 7.25, w: 1.62, h: 2.19 },
    leafX: 4.39,
    headingBaseline: 7.16,
  },
  "eggs-and-dairy": {
    box: { x: 6.21, y: 2.51, w: 1.91, h: 3.06 },
    leafX: 6.32,
    headingBaseline: 2.39,
  },
  "other-foods": {
    box: { x: 6.27, y: 5.86, w: 1.85, h: 4.11 },
    leafX: 6.32,
    headingBaseline: 5.81,
  },
};

/** Gap between the heading's leaf bullet and its text (the space after the inline
 * image in the document's heading runs). */
const LEAF_TEXT_GAP = 0.04;

// ---- Asset loading -------------------------------------------------------
// Fonts are open substitutes for the document's proprietary Microsoft fonts:
// Carlito is metric-compatible with Calibri (identical advance widths, so text
// occupies exactly the same space), and Lato is the brand font the document
// itself specifies. Both are OFL-licensed and therefore embeddable.
// The three images are extracted verbatim from the .docx, so the branding is the
// clinic's own artwork rather than a lookalike.

const ASSET_DIR = path.join(process.cwd(), "src", "server", "pdf");

type Assets = {
  carlito: Buffer;
  carlitoBold: Buffer;
  lato: Buffer;
  latoBold: Buffer;
  wordmark: Buffer;
  qr: Buffer;
  leaf: Buffer;
  leafDot: Buffer;
};

let assetsPromise: Promise<Assets> | null = null;

/** Reads fonts/images once per process — a cold start pays for this, not every request. */
function loadAssets(): Promise<Assets> {
  if (!assetsPromise) {
    const font = (f: string) => readFile(path.join(ASSET_DIR, "fonts", f));
    const asset = (f: string) => readFile(path.join(ASSET_DIR, "assets", f));
    assetsPromise = Promise.all([
      font("Carlito-Regular.ttf"),
      font("Carlito-Bold.ttf"),
      font("Lato-Regular.ttf"),
      font("Lato-Bold.ttf"),
      asset("layaka-wordmark-white.png"),
      asset("layaka-qr-white.png"),
      asset("layaka-leaf.png"),
      asset("layaka-leaf-dot.png"),
    ]).then(([carlito, carlitoBold, lato, latoBold, wordmark, qr, leaf, leafDot]) => ({
      carlito,
      carlitoBold,
      lato,
      latoBold,
      wordmark,
      qr,
      leaf,
      leafDot,
    }));
  }
  return assetsPromise;
}

// ---- Text helpers --------------------------------------------------------

/**
 * Drops characters the embedded (subset) font can't encode. The Notes field is
 * free text a doctor can paste anything into — an emoji or Arabic character
 * would otherwise make pdf-lib throw and take the whole PDF down, so unsupported
 * characters are quietly removed rather than failing the generation.
 */
function makeSanitizer(font: PDFFont): (text: string) => string {
  const supported = new Set(font.getCharacterSet());
  return (text: string) =>
    [...text]
      .filter((ch) => {
        const cp = ch.codePointAt(0);
        return cp !== undefined && supported.has(cp);
      })
      .join("");
}

/**
 * Greedy word wrap, breaking over-long words mid-token.
 *
 * `restWidth` defaults to `maxWidth` but may be wider: inside a category box the
 * FIRST line has to share its row with the checkbox, while wrapped continuation
 * lines start at the box's left inset and get the full inner width. That's what
 * Word does, and it's load-bearing — with a single width, "Walnuts / Pistachios"
 * splits again into a third line, where the paper form keeps it on one.
 */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  restWidth = maxWidth,
): string[] {
  const lines: string[] = [];
  let line = "";
  const widthFor = () => (lines.length === 0 ? maxWidth : restWidth);
  for (const word of tokenize(text)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= widthFor() || !line) {
      // A single word wider than the column still has to go somewhere: keep it on
      // its own line and let the character-level break below handle it.
      if (font.widthOfTextAtSize(candidate, size) > widthFor() && !line) {
        let chunk = "";
        for (const ch of candidate) {
          if (font.widthOfTextAtSize(chunk + ch, size) > widthFor() && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
        continue;
      }
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Splits on spaces but keeps a lone "/" or "-" attached to the word before it, so
 * a break never leaves a separator stranded at the start of a line.
 *
 * This is a break-opportunity rule, applied while measuring — not a fix-up
 * afterwards. Moving a separator back onto the previous line after the fact can
 * push that line past the margin, which is exactly how "Almonds / Walnuts /" came
 * to sit half a point from its border. It also reproduces the paper form's own
 * break points: "Almonds /" + "Walnuts / Pistachios", "Pasta / Pizza /" + "Flour",
 * "Herbs: Cabbage -" + "Purslane - Parsley -" + "Thyme - Mint - etc.".
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if ((raw === "/" || raw === "-") && out.length > 0) out[out.length - 1] += ` ${raw}`;
    else out.push(raw);
  }
  return out;
}

/**
 * Fits free text onto at most `maxLines` ruled lines, shrinking the type before
 * it resorts to truncating. The paper form gives Notes a single rule; long notes
 * step down in size and may run to a second line rather than silently vanishing.
 */
function fitText(
  text: string,
  font: PDFFont,
  maxWidth: number,
  maxLines: number,
  sizes: number[],
): { lines: string[]; size: number } {
  for (const size of sizes) {
    const lines = wrapText(text, font, size, maxWidth);
    if (lines.length <= maxLines) return { lines, size };
  }
  const size = sizes[sizes.length - 1];
  const lines = wrapText(text, font, size, maxWidth).slice(0, maxLines);
  const last = lines.length - 1;
  if (last >= 0) {
    let truncated = lines[last];
    while (truncated && font.widthOfTextAtSize(`${truncated}…`, size) > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    lines[last] = `${truncated}…`;
  }
  return { lines, size };
}

// ---- Drawing primitives --------------------------------------------------

/** An empty checkbox, or a ticked one with a drawn checkmark.
 *
 * The document's ☐ comes from Segoe UI Symbol (a proprietary Windows font that
 * can't be embedded), so the box and its tick are drawn as vectors instead —
 * which also renders more crisply than any substitute glyph would. */
function drawCheckboxAt(page: PDFPage, x: number, baselineY: number, checked: boolean) {
  const y = baselineY - 0.5;
  page.drawRectangle({
    x,
    y,
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderColor: ITEM_TEXT,
    borderWidth: 0.75,
  });
  if (!checked) return;
  const s = CHECKBOX_SIZE;
  page.drawLine({
    start: { x: x + s * 0.2, y: y + s * 0.52 },
    end: { x: x + s * 0.42, y: y + s * 0.24 },
    thickness: 1.3,
    color: ITEM_TEXT,
  });
  page.drawLine({
    start: { x: x + s * 0.4, y: y + s * 0.24 },
    end: { x: x + s * 0.84, y: y + s * 0.82 },
    thickness: 1.3,
    color: ITEM_TEXT,
  });
}

export type FoodListPdfInput = {
  patientName: string;
  notes?: string;
  /** Catalog item ids that are ticked (already normalized by the caller). */
  selections: readonly string[];
};

/**
 * Renders the form to PDF bytes. Ticked items print with a checkmark; Name and
 * Notes print the saved values on the form's ruled lines.
 */
export async function renderFoodListPdf(input: FoodListPdfInput): Promise<Buffer> {
  const a = await loadAssets();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const bodyBold = await pdf.embedFont(a.carlitoBold, { subset: true });
  const accent = await pdf.embedFont(a.lato, { subset: true });
  const accentBold = await pdf.embedFont(a.latoBold, { subset: true });
  const wordmark = await pdf.embedPng(a.wordmark);
  const qr = await pdf.embedPng(a.qr);
  const leaf = await pdf.embedPng(a.leaf);
  const leafDot = await pdf.embedPng(a.leafDot);

  const clean = makeSanitizer(bodyBold);
  const cleanAccent = makeSanitizer(accent);

  pdf.setTitle(FOOD_LIST_TITLE);
  pdf.setSubject(FOOD_LIST_SUBTITLE);
  pdf.setProducer("NutriClinic");
  pdf.setCreator("NutriClinic");

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  // PDF pages are transparent by default; paint the sheet white so the form looks
  // the same when it's rasterised or composited, not just in a viewer that
  // happens to draw a white backdrop.
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: WHITE });
  const ticked = new Set(input.selections);

  drawHeader(page, { wordmark, qr, leafDot, accent });
  drawTitleBlock(page, { bodyBold, accentBold });
  drawCategories(page, { bodyBold, leaf, ticked });
  drawFields(page, { bodyBold, leaf, clean, input });
  drawFooter(page, { accent, cleanAccent });

  return Buffer.from(await pdf.save());
}

function drawHeader(
  page: PDFPage,
  {
    wordmark,
    qr,
    leafDot,
    accent,
  }: { wordmark: PDFImage; qr: PDFImage; leafDot: PDFImage; accent: PDFFont },
) {
  page.drawRectangle({
    x: 0,
    y: yFromTop(BAND_BOTTOM),
    width: PAGE_W,
    height: pt(BAND_BOTTOM),
    color: TEAL_BAND,
  });
  page.drawImage(wordmark, {
    x: pt(LOGO.x),
    y: yFromTop(LOGO.y + LOGO.h),
    width: pt(LOGO.w),
    height: pt(LOGO.h),
  });
  page.drawImage(qr, {
    x: pt(QR.x),
    y: yFromTop(QR.y + QR.h),
    width: pt(QR.w),
    height: pt(QR.h),
  });

  // The specialities strip: four labels separated by small dots. The document
  // spaces these with tab stops; here the row is measured and centred, shrinking
  // the type if needed so it always stays on one line as it does on paper.
  const gap = 14;
  let size = SZ_SPECIALITIES;
  const rowWidth = (s: number) =>
    FOOD_LIST_SPECIALITIES.reduce((sum, label) => sum + accent.widthOfTextAtSize(label, s), 0) +
    gap * 2 * (FOOD_LIST_SPECIALITIES.length - 1);
  while (size > 7 && rowWidth(size) > pt(SPECIALITIES_MAX_W)) size -= 0.25;

  let x = (PAGE_W - rowWidth(size)) / 2;
  const baseline = yFromTop(SPECIALITIES_BASELINE);
  FOOD_LIST_SPECIALITIES.forEach((label, i) => {
    page.drawText(label, { x, y: baseline, size, font: accent, color: WHITE });
    x += accent.widthOfTextAtSize(label, size);
    if (i < FOOD_LIST_SPECIALITIES.length - 1) {
      // The separator is the document's own tiny white leaf (word/media/image3),
      // not a bullet — embedded verbatim rather than approximated with a dot.
      const s = SPECIALITIES_SEPARATOR;
      page.drawImage(leafDot, {
        x: x + gap - s / 2,
        y: baseline + size * 0.28 - s / 2,
        width: s,
        height: s,
      });
      x += gap * 2;
    }
  });
}

function drawTitleBlock(
  page: PDFPage,
  { bodyBold, accentBold }: { bodyBold: PDFFont; accentBold: PDFFont },
) {
  const title = FOOD_LIST_TITLE;
  page.drawText(title, {
    x: pt(TITLE_CENTER_X) - bodyBold.widthOfTextAtSize(title, SZ_TITLE) / 2,
    y: yFromTop(TITLE_BASELINE),
    size: SZ_TITLE,
    font: bodyBold,
    color: TEAL_TEXT,
  });
  const subtitle = FOOD_LIST_SUBTITLE;
  page.drawText(subtitle, {
    x: pt(TITLE_CENTER_X) - accentBold.widthOfTextAtSize(subtitle, SZ_SUBTITLE) / 2,
    y: yFromTop(SUBTITLE_BASELINE),
    size: SZ_SUBTITLE,
    font: accentBold,
    color: TEAL_TEXT,
  });
}

function drawCategories(
  page: PDFPage,
  { bodyBold, leaf, ticked }: { bodyBold: PDFFont; leaf: PDFImage; ticked: Set<string> },
) {
  for (const category of FOOD_LIST_CATEGORIES) {
    const geo = CATEGORY_BOXES[category.id];
    if (!geo) continue;
    const { box } = geo;

    // Leaf-bulleted heading, sitting above its box: leaf first, then the text.
    page.drawImage(leaf, {
      x: pt(geo.leafX),
      y: yFromTop(geo.headingBaseline) - 1,
      width: pt(LEAF_SIZE),
      height: pt(LEAF_SIZE),
    });
    const headingTextX = geo.leafX + LEAF_SIZE + LEAF_TEXT_GAP;
    // "Plant-based proteins" is too wide for its column and wraps on the paper
    // form; wrapping here reproduces that rather than letting it overrun. Wrapped
    // heading lines return to the box's left edge, as the item labels do.
    const headingLines = wrapText(
      category.title,
      bodyBold,
      SZ_HEADING,
      pt(box.x + box.w - headingTextX),
      pt(box.w),
    );
    headingLines.forEach((line, i) => {
      page.drawText(line, {
        x: pt(i === 0 ? headingTextX : box.x),
        y: yFromTop(geo.headingBaseline + i * 0.24),
        size: SZ_HEADING,
        font: bodyBold,
        color: TEAL_TEXT,
      });
    });

    // Lay the items out first: the box is then drawn tall enough to contain them
    // with the document's bottom inset intact, so a label can never be clipped by
    // or crowd against the border. Every box but "Nuts and seeds" already has
    // slack at the document's own height; that one is a few points short of its
    // wrapped content and grows accordingly.
    const lineHeight = bodyBold.heightAtSize(SZ_ITEM, { descender: true });
    const pitch = lineHeight * (LINE_SPACING[category.id] ?? 1);
    const ascent = bodyBold.heightAtSize(SZ_ITEM, { descender: false });

    const checkboxX = box.x + BOX_INSET_X;
    const labelX = pt(checkboxX) + CHECKBOX_SIZE + CHECKBOX_GAP;
    const innerRight = pt(box.x + box.w) - pt(BOX_INSET_X);
    // First line shares its row with the checkbox; wrapped lines start at the
    // box's left inset and so get the full inner width (as Word lays them out).
    const firstLineW = innerRight - labelX;
    const restLineW = innerRight - pt(checkboxX);

    const rows = category.items.map((item) => ({
      item,
      lines: wrapText(item.label, bodyBold, SZ_ITEM, firstLineW, restLineW),
    }));
    const totalLines = rows.reduce((n, r) => n + r.lines.length, 0);
    const contentH = pt(BOX_INSET_Y) + (totalLines - 1) * pitch + lineHeight + pt(BOX_INSET_Y);
    const boxH = Math.max(pt(box.h), contentH);

    page.drawRectangle({
      x: pt(box.x),
      y: yFromTop(box.y) - boxH,
      width: pt(box.w),
      height: boxH,
      borderColor: BOX_BORDER,
      borderWidth: 0.5,
    });

    // First baseline sits one ascender below the box's top inset.
    const firstBaselineY = yFromTop(box.y) - pt(BOX_INSET_Y) - ascent;
    let line = 0;
    for (const { item, lines } of rows) {
      drawCheckboxAt(page, pt(checkboxX), firstBaselineY - line * pitch, ticked.has(item.id));
      lines.forEach((text, i) => {
        page.drawText(text, {
          x: i === 0 ? labelX : pt(checkboxX),
          y: firstBaselineY - (line + i) * pitch,
          size: SZ_ITEM,
          font: bodyBold,
          color: ITEM_TEXT,
        });
      });
      line += lines.length;
    }
  }
}

function drawFields(
  page: PDFPage,
  {
    bodyBold,
    leaf,
    clean,
    input,
  }: {
    bodyBold: PDFFont;
    leaf: PDFImage;
    clean: (t: string) => string;
    input: FoodListPdfInput;
  },
) {
  const rows: { label: string; baseline: number }[] = [
    { label: "Name:", baseline: NAME_BASELINE },
    { label: "Notes:", baseline: NOTES_BASELINE },
  ];
  for (const row of rows) {
    page.drawImage(leaf, {
      x: pt(FIELD_LABEL_X - LEAF_SIZE - 0.03),
      y: yFromTop(row.baseline) - 1,
      width: pt(LEAF_SIZE),
      height: pt(LEAF_SIZE),
    });
    page.drawText(row.label, {
      x: pt(FIELD_LABEL_X),
      y: yFromTop(row.baseline),
      size: SZ_FIELD,
      font: bodyBold,
      color: TEAL_TEXT,
    });
    page.drawLine({
      start: { x: pt(RULE_X0), y: yFromTop(row.baseline) - 3 },
      end: { x: pt(RULE_X1), y: yFromTop(row.baseline) - 3 },
      thickness: 1,
      color: RULE,
    });
  }

  const ruleWidth = pt(RULE_X1 - RULE_X0) - 8;
  const name = clean(input.patientName).trim();
  if (name) {
    const fitted = fitText(name, bodyBold, ruleWidth, 1, [14, 13, 12, 11, 10, 9]);
    page.drawText(fitted.lines[0], {
      x: pt(RULE_X0) + 4,
      y: yFromTop(NAME_BASELINE),
      size: fitted.size,
      font: bodyBold,
      color: ITEM_TEXT,
    });
  }

  const notes = clean(input.notes ?? "").trim();
  if (notes) {
    // The paper form gives Notes one rule; allow a second line in the gap above
    // the footer before truncating, so a longer note still prints in full.
    const fitted = fitText(notes, bodyBold, ruleWidth, 2, [13, 12, 11, 10, 9, 8.5]);
    fitted.lines.forEach((text, i) => {
      page.drawText(text, {
        x: pt(RULE_X0) + 4,
        y: yFromTop(NOTES_BASELINE + i * 0.19),
        size: fitted.size,
        font: bodyBold,
        color: ITEM_TEXT,
      });
    });
  }
}

function drawFooter(
  page: PDFPage,
  { accent, cleanAccent }: { accent: PDFFont; cleanAccent: (t: string) => string },
) {
  page.drawRectangle({
    x: 0,
    y: yFromTop(FOOTER.y + FOOTER.h),
    width: PAGE_W,
    height: pt(FOOTER.h),
    color: TEAL_FOOTER,
  });
  const text = cleanAccent(FOOD_LIST_FOOTER);
  page.drawText(text, {
    x: (PAGE_W - accent.widthOfTextAtSize(text, SZ_FOOTER)) / 2,
    y: yFromTop(FOOTER_BASELINE),
    size: SZ_FOOTER,
    font: accent,
    color: WHITE,
  });
}
