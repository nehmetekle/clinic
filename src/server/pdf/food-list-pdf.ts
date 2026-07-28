import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import {
  beginText,
  endText,
  PDFDocument,
  PDFHexString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import {
  categoryTitle,
  FOOD_LIST_CATEGORIES,
  FOOD_LIST_FIELD_LABELS,
  FOOD_LIST_FOOTER,
  FOOD_LIST_SPECIALITIES,
  foodListSubtitle,
  foodListTitle,
  isRtl,
  itemLabel,
  type FoodListLanguage,
} from "@/lib/food-list";

/**
 * Renders the Nutrient-Rich Foods List as a one-page PDF replicating Layaka's
 * paper forms — "Patient paper english.docx" and its Arabic counterpart
 * "Patient paper 1.docx".
 *
 * Why pdf-lib and not HTML→PDF: the source is a fixed single-page layout of
 * absolutely-positioned boxes, and the app deploys to Vercel (see vercel.json)
 * where a headless browser isn't practical. Every coordinate below was measured
 * off the .docx — the shape offsets/extents in word/document.xml, cross-checked
 * against a render of the original — so this is a transcription of the documents'
 * real geometry, not an approximation of how they look.
 *
 * The two editions share this renderer: everything language-specific lives in
 * LAYOUTS below, so a change to the drawing code applies to both and the English
 * output can't drift while working on Arabic.
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

// ---- Palette, verbatim from the documents (identical in both) ----
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

// ---- Header band (identical in both editions) ----
// The teal band runs off the top of the page; a white rectangle in the document
// trims it at 1.5in, which is the visible edge reproduced here. The band, the
// wordmark, the QR code and the specialities strip are byte-identical between the
// English and Arabic documents — the strip deliberately stays in Latin script.
const BAND_BOTTOM = 1.5;
const LOGO = { x: 2.361, y: 0.114, w: 3.591, h: 0.923 };
const QR = { x: 6.925, y: 0.187, w: 0.827, h: 0.778 };
const SPECIALITIES_BASELINE = 1.28;
const SPECIALITIES_MAX_W = 7.9;
const SPECIALITIES_SEPARATOR = 5; // pt — the document's separator is 0.07in

// ---- Title block (both editions centre it on the same axis) ----
const TITLE_CENTER_X = 4.245;
const TITLE_BASELINE = 1.79;
const SUBTITLE_BASELINE = 2.03;

// ---- Footer bar (identical in both editions, Latin + Western numerals) ----
const FOOTER = { y: 10.62, h: 0.32 };
const FOOTER_BASELINE = 10.83;

// ---- Type sizes, from the documents' run properties ----
const SZ_TITLE = 20; // Calibri Light bold  -> Carlito bold
const SZ_SUBTITLE = 12; // Lato bold
const SZ_HEADING = 16; // Calibri bold       -> Carlito bold
const SZ_ITEM = 12.5; // Calibri bold       -> Carlito bold
const SZ_FIELD = 16; // Calibri bold       -> Carlito bold
const SZ_FOOTER = 11; // Lato
const SZ_SPECIALITIES = 12; // Lato

// ---- Item layout inside a category box ----
// Word's text-box insets, read from each shape's <wps:bodyPr>. The ENGLISH
// document sets 0.1in left/right and 0.05in top/bottom; these are what keep the
// labels clear of the border. The ARABIC document sets them all to ZERO, which
// would put text flush against (and clipped by) the border — so the English
// insets are applied to both editions by decision. See docs/known-issues.md §10.
const BOX_INSET_X = 0.1;
const BOX_INSET_Y = 0.05;
const CHECKBOX_SIZE = 8; // pt — matches the ☐ glyph's box at 12.5pt
const CHECKBOX_GAP = 4; // pt between the box and its label
const LEAF_SIZE = 0.2; // the leaf bullet is exactly 0.2in in both documents
/** Gap between the heading's leaf bullet and its text. */
const LEAF_TEXT_GAP = 0.04;

/** Where a category's outlined box and its leaf-bulleted heading sit. */
type CategoryGeometry = {
  box: { x: number; y: number; w: number; h: number };
  /** The heading's leaf bullet. In LTR it starts here and the text follows to the
   * right; in RTL this is the leaf's RIGHT edge and the text runs leftwards. */
  leafX: number;
  headingBaseline: number;
};

type LayoutSpec = {
  rtl: boolean;
  /** Line spacing per category (`<w:spacing w:line=…>` / 240). */
  lineSpacing: Record<string, number>;
  /**
   * Item line pitch and first-baseline drop, in points, overriding the values
   * derived from the font's own metrics.
   *
   * Needed for Arabic: Noto Sans Arabic declares a very tall default line box
   * (26.4pt at 12.5pt, against Carlito's 15.26pt) to leave room for vocalisation
   * marks the form never uses. Taking it at face value made every column overflow
   * its box and collide with the category below. The Arabic document's own
   * geometry implies ~19.8pt, consistent across six of its eight boxes, so that
   * is used instead. English omits these and keeps deriving from the font.
   */
  itemLineHeightPt?: number;
  itemAscentPt?: number;
  categories: Record<string, CategoryGeometry>;
  /** Name / Notes rows. `labelAnchorX` is the label's left edge in LTR and its
   * right edge in RTL; the rule runs between ruleX0..ruleX1 in both. */
  fields: {
    labelAnchorX: number;
    ruleX0: number;
    ruleX1: number;
    nameBaseline: number;
    notesBaseline: number;
  };
};

/**
 * ENGLISH — measured from "Patient paper english.docx".
 *
 * Line spacing is genuinely NOT uniform here: the form was hand-built and boxes
 * were formatted differently, which is why a single guessed pitch made some
 * columns overflow their box and others sit loose.
 *
 * `leafX` is where the heading's leaf bullet starts — in the document the leaf is
 * the first inline element of the heading run, so it sits at the heading box's
 * left inset and the text follows it. (Treating this as the TEXT position and
 * back-spacing the leaf shifts every heading left and pushes the "Nuts and seeds"
 * leaf over the Vegetables box border.)
 */
const LAYOUT_EN: LayoutSpec = {
  rtl: false,
  lineSpacing: {
    vegetables: 276 / 240, // 1.15
    fruits: 1, // single
    "nuts-and-seeds": 280 / 240, // ~1.167
    "animal-proteins": 1, // single
    "plant-based-proteins": 1, // single
    carbohydrates: 1, // single
    "eggs-and-dairy": 276 / 240, // 1.15
    "other-foods": 276 / 240, // 1.15
  },
  categories: {
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
  },
  fields: {
    labelAnchorX: 0.37,
    ruleX0: 1.31,
    ruleX1: 6.09,
    nameBaseline: 10.05,
    notesBaseline: 10.35,
  },
};

/**
 * ARABIC — measured from "Patient paper 1.docx".
 *
 * The page is a mirror of the English one: reading order runs right-to-left, so
 * Vegetables is the RIGHTMOST column and Eggs and Dairy the leftmost. Shape
 * offsets were read the same way (relativeFrom="page" is absolute; "margin" and
 * "column" add the 1in margin; vertical offsets add 1.0in as in the English doc).
 *
 * Unlike English, every box here uses single line spacing and a uniform 1.7in
 * width — the Arabic form was laid out more consistently.
 */
const LAYOUT_AR: LayoutSpec = {
  rtl: true,
  lineSpacing: {
    vegetables: 1,
    fruits: 1,
    "nuts-and-seeds": 1,
    "animal-proteins": 1,
    "plant-based-proteins": 1,
    carbohydrates: 1,
    "eggs-and-dairy": 1,
    "other-foods": 1,
  },
  itemLineHeightPt: 19.8,
  itemAscentPt: 13,
  categories: {
    vegetables: { box: { x: 6.4, y: 2.39, w: 1.7, h: 6.99 }, leafX: 8.1, headingBaseline: 2.28 },
    fruits: { box: { x: 4.38, y: 2.38, w: 1.7, h: 5.84 }, leafX: 6.08, headingBaseline: 2.28 },
    "nuts-and-seeds": {
      box: { x: 4.45, y: 8.54, w: 1.67, h: 1.21 },
      leafX: 6.12,
      headingBaseline: 8.44,
    },
    "animal-proteins": {
      box: { x: 2.36, y: 2.38, w: 1.7, h: 2.57 },
      leafX: 4.06,
      headingBaseline: 2.28,
    },
    "plant-based-proteins": {
      box: { x: 2.37, y: 5.29, w: 1.7, h: 1.61 },
      leafX: 4.07,
      headingBaseline: 5.19,
    },
    carbohydrates: {
      box: { x: 2.37, y: 7.24, w: 1.7, h: 2.51 },
      leafX: 4.07,
      headingBaseline: 7.14,
    },
    "eggs-and-dairy": {
      box: { x: 0.36, y: 2.37, w: 1.7, h: 2.63 },
      leafX: 2.06,
      headingBaseline: 2.28,
    },
    "other-foods": {
      box: { x: 0.39, y: 5.37, w: 1.7, h: 3.93 },
      leafX: 2.09,
      headingBaseline: 5.27,
    },
  },
  fields: {
    labelAnchorX: 8.13,
    ruleX0: 1.04,
    ruleX1: 6.8,
    nameBaseline: 10.04,
    notesBaseline: 10.39,
  },
};

const LAYOUTS: Record<FoodListLanguage, LayoutSpec> = { en: LAYOUT_EN, ar: LAYOUT_AR };

// ---- Asset loading -------------------------------------------------------
// Fonts are open substitutes for the documents' fonts. Carlito is
// metric-compatible with Calibri (identical advance widths, so Latin text
// occupies exactly the same space and breaks in the same places), and Lato is the
// brand font the English document specifies. The Arabic document pins no Arabic
// typeface at all (its theme's complex-script entry is empty), so Noto Sans
// Arabic was chosen for legibility. All are OFL-licensed and embeddable.
// The images are extracted verbatim from the .docx files, so the branding is the
// clinic's own artwork rather than a lookalike.

const ASSET_DIR = path.join(process.cwd(), "src", "server", "pdf");

type Assets = {
  carlito: Buffer;
  carlitoBold: Buffer;
  lato: Buffer;
  latoBold: Buffer;
  arabic: Buffer;
  arabicBold: Buffer;
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
      font("NotoSansArabic-Regular.ttf"),
      font("NotoSansArabic-Bold.ttf"),
      asset("layaka-wordmark-white.png"),
      asset("layaka-qr-white.png"),
      asset("layaka-leaf.png"),
      asset("layaka-leaf-dot.png"),
    ]).then(
      ([
        carlito,
        carlitoBold,
        lato,
        latoBold,
        arabic,
        arabicBold,
        wordmark,
        qr,
        leaf,
        leafDot,
      ]) => ({
        carlito,
        carlitoBold,
        lato,
        latoBold,
        arabic,
        arabicBold,
        wordmark,
        qr,
        leaf,
        leafDot,
      }),
    );
  }
  return assetsPromise;
}

// ---- Bidirectional text --------------------------------------------------

const bidi = bidiFactory();

/**
 * A pair of fonts for one piece of text: the script-appropriate face for RTL runs
 * and the Latin face for everything else. In the English edition both are Latin.
 */
type FontPair = { rtl: PDFFont; ltr: PDFFont };

/**
 * Splits text into runs of uniform direction — each kept in LOGICAL order — and
 * returns them in VISUAL left-to-right order.
 *
 * Keeping each run logical is essential: fontkit (which pdf-lib delegates to)
 * already shapes Arabic and reverses RTL runs internally, so reversing the
 * characters here too double-flips them and produces disconnected, backwards
 * text. Only the ORDER OF THE RUNS is rearranged.
 */
function visualRuns(text: string, baseRtl: boolean): { text: string; rtl: boolean }[] {
  if (!text) return [];
  const { levels } = bidi.getEmbeddingLevels(text, baseRtl ? "rtl" : "ltr");
  const runs: { text: string; rtl: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const rtl = levels[i] % 2 === 1;
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.text += text[i];
    else runs.push({ text: text[i], rtl });
  }
  return baseRtl ? runs.reverse() : runs;
}

/**
 * Faces we draw glyph-by-glyph instead of via `page.drawText`, keyed by the
 * embedded font. See `drawShaped` for why; empty for the English edition.
 */
const shapedFaces = new WeakMap<PDFFont, fontkit.Font>();

/**
 * Parsed once per process like the font bytes themselves — `layout` only reads,
 * so the same instance is safe to share across renders (pdf-lib's embedder keeps
 * its own copy regardless).
 */
let arabicShaper: fontkit.Font | null = null;
function shaperFor(bytes: Buffer): fontkit.Font {
  if (!arabicShaper) arabicShaper = fontkit.create(bytes);
  return arabicShaper;
}

/**
 * Draws one run by emitting positioned glyphs, because `page.drawText` cannot
 * render this script correctly.
 *
 * pdf-lib's `CustomFontEmbedder.encodeText` keeps only the `.glyphs` of the
 * fontkit run and throws `.positions` away, so every GPOS x/y offset is lost.
 * That is fatal for Noto Sans Arabic: its `ccmp` feature splits each letter into
 * a dotless base plus a SEPARATE ZERO-ADVANCE mark glyph for the dots, and the
 * mark's only placement is that discarded offset. Dropped, every dot collapses
 * onto the base's origin — a final Yeh's two dots land 0.23em below and 0.19em
 * beside the letter they belong to, which is the "dots don't match the letters"
 * the Arabic page showed.
 *
 * Turning `ccmp` off is NOT the fix, tempting as it looks: this font's
 * init/medi/fina lookups match on the decomposed bases, so without `ccmp` every
 * letter falls back to its isolated form and the cursive joining breaks
 * (`فو` measures 1029 units joined vs 1548 unjoined).
 *
 * Positioning each glyph absolutely also restores GPOS `xAdvance`, so kerning —
 * which `widthOfTextAtSize` likewise ignores — is applied rather than dropped.
 *
 * Requires the face to be embedded with `subset: false`: `CustomFontSubsetEmbedder`
 * renumbers glyph ids through `subset.includeGlyph`, and we emit raw ids against
 * the Identity-H / CIDToGIDMap=Identity encoding pdf-lib writes.
 */
function drawShaped(
  page: PDFPage,
  run: fontkit.GlyphRun,
  opts: { x: number; y: number; size: number; font: PDFFont; kit: fontkit.Font; color: RGB },
): void {
  const scale = opts.size / opts.kit.unitsPerEm;
  const key = page.node.newFontDictionary(opts.font.name, opts.font.ref);
  const ops = [
    pushGraphicsState(),
    beginText(),
    setFillingRgbColor(opts.color.red, opts.color.green, opts.color.blue),
    setFontAndSize(key, opts.size),
  ];
  let pen = 0;
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    // Absolute placement per glyph: the pen carries the run's own advances, and
    // the offsets are what pdf-lib would have dropped.
    ops.push(
      setTextMatrix(1, 0, 0, 1, opts.x + (pen + pos.xOffset) * scale, opts.y + pos.yOffset * scale),
      showText(PDFHexString.of(glyph.id.toString(16).toUpperCase().padStart(4, "0"))),
    );
    pen += pos.xAdvance;
  });
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/**
 * Width of one run. Shaped faces are measured off the same layout they are drawn
 * from, so measurement and drawing cannot disagree; every other face keeps
 * pdf-lib's own measurement so the English page is untouched.
 */
function runWidth(text: string, font: PDFFont, size: number): number {
  const kit = shapedFaces.get(font);
  if (!kit) return font.widthOfTextAtSize(text, size);
  return (kit.layout(text).advanceWidth * size) / kit.unitsPerEm;
}

/** Width of a possibly mixed-direction string, summed across its runs. */
function measure(text: string, fonts: FontPair, size: number, baseRtl: boolean): number {
  return visualRuns(text, baseRtl).reduce(
    (sum, r) => sum + runWidth(r.text, r.rtl ? fonts.rtl : fonts.ltr, size),
    0,
  );
}

/**
 * Draws one line of possibly mixed-direction text.
 * `anchorX` is the left edge when `baseRtl` is false, and the RIGHT edge when it
 * is true — which is how every RTL element on the Arabic page is positioned.
 */
function drawLine(
  page: PDFPage,
  text: string,
  opts: {
    anchorX: number;
    baselineY: number;
    size: number;
    fonts: FontPair;
    color: RGB;
    baseRtl: boolean;
  },
): void {
  const runs = visualRuns(text, opts.baseRtl);
  if (runs.length === 0) return;
  const fontOf = (r: { rtl: boolean }) => (r.rtl ? opts.fonts.rtl : opts.fonts.ltr);
  const widths = runs.map((r) => runWidth(r.text, fontOf(r), opts.size));
  const total = widths.reduce((a, b) => a + b, 0);
  let x = opts.baseRtl ? opts.anchorX - total : opts.anchorX;
  runs.forEach((r, i) => {
    const font = fontOf(r);
    const kit = shapedFaces.get(font);
    if (kit) {
      drawShaped(page, kit.layout(r.text), {
        x,
        y: opts.baselineY,
        size: opts.size,
        font,
        kit,
        color: opts.color,
      });
    } else {
      page.drawText(r.text, {
        x,
        y: opts.baselineY,
        size: opts.size,
        font,
        color: opts.color,
      });
    }
    x += widths[i];
  });
}

// ---- Text helpers --------------------------------------------------------

/**
 * Drops characters none of the embedded (subset) fonts can encode. The Notes
 * field is free text a doctor can paste anything into — an emoji, or Arabic in
 * the English form — which would otherwise make pdf-lib throw and take the whole
 * PDF down, so unsupported characters are quietly removed rather than failing.
 */
function makeSanitizer(fonts: PDFFont[]): (text: string) => string {
  const supported = new Set<number>();
  for (const f of fonts) for (const cp of f.getCharacterSet()) supported.add(cp);
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
 * lines start at the box's inset and get the full inner width. That's what Word
 * does, and it's load-bearing — with a single width, "Walnuts / Pistachios"
 * splits again into a third line, where the paper form keeps it on one.
 */
function wrapText(
  text: string,
  fonts: FontPair,
  size: number,
  maxWidth: number,
  baseRtl: boolean,
  restWidth = maxWidth,
): string[] {
  const lines: string[] = [];
  let line = "";
  const widthFor = () => (lines.length === 0 ? maxWidth : restWidth);
  const w = (s: string) => measure(s, fonts, size, baseRtl);
  for (const token of tokenize(text)) {
    const word = token.text;
    // Re-join with a space only where the source had one, so breaking inside an
    // unspaced run like "معكرونة/بيتزا/طحين" can't invent spaces that aren't there.
    const candidate = line ? `${line}${token.space ? " " : ""}${word}` : word;
    if (w(candidate) <= widthFor() || !line) {
      // A single word wider than the column still has to go somewhere: keep it on
      // its own line and let the character-level break below handle it.
      if (w(candidate) > widthFor() && !line) {
        let chunk = "";
        for (const ch of candidate) {
          if (w(chunk + ch) > widthFor() && chunk) {
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
function tokenize(text: string): { text: string; space: boolean }[] {
  const words: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if ((raw === "/" || raw === "-") && words.length > 0) words[words.length - 1] += ` ${raw}`;
    else words.push(raw);
  }
  // A "/" with no space around it is still a break opportunity (UAX #14 allows a
  // break after SOLIDUS). The Arabic labels rely on this — "معكرونة/بيتزا/طحين"
  // is one whitespace-delimited word too wide for its column, and without this it
  // would break mid-word instead of at a slash. No English label contains an
  // unspaced slash, so this leaves that edition untouched.
  const out: { text: string; space: boolean }[] = [];
  words.forEach((word, wi) => {
    const parts = word.split(/(?<=\/)(?=[^\s/])/);
    parts.forEach((part, pi) => out.push({ text: part, space: pi === 0 && wi > 0 }));
  });
  return out;
}

/**
 * Fits free text onto at most `maxLines` ruled lines, shrinking the type before
 * it resorts to truncating. The paper form gives Notes a single rule; long notes
 * step down in size and may run to a second line rather than silently vanishing.
 */
function fitText(
  text: string,
  fonts: FontPair,
  maxWidth: number,
  maxLines: number,
  sizes: number[],
  baseRtl: boolean,
): { lines: string[]; size: number } {
  for (const size of sizes) {
    const lines = wrapText(text, fonts, size, maxWidth, baseRtl);
    if (lines.length <= maxLines) return { lines, size };
  }
  const size = sizes[sizes.length - 1];
  const lines = wrapText(text, fonts, size, maxWidth, baseRtl).slice(0, maxLines);
  const last = lines.length - 1;
  if (last >= 0) {
    let truncated = lines[last];
    while (truncated && measure(`${truncated}…`, fonts, size, baseRtl) > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    lines[last] = `${truncated}…`;
  }
  return { lines, size };
}

// ---- Drawing primitives --------------------------------------------------

/** An empty checkbox, or a ticked one with a drawn checkmark.
 *
 * The documents' ☐ comes from Segoe UI Symbol (a proprietary Windows font that
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
  language: FoodListLanguage;
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
  const language = input.language;
  const layout = LAYOUTS[language];
  const rtl = isRtl(language);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const carlitoBold = await pdf.embedFont(a.carlitoBold, { subset: true });
  const accent = await pdf.embedFont(a.lato, { subset: true });
  const accentBold = await pdf.embedFont(a.latoBold, { subset: true });
  // Only embed the Arabic faces for the Arabic edition, so an English PDF carries
  // exactly the fonts it did before this edition existed.
  // `subset: false` is required, not incidental — `drawShaped` emits raw glyph
  // ids, which only address the right glyphs while pdf-lib is not renumbering
  // them through a subset. Costs ~70KB in the Arabic PDF only.
  const arabicBold = rtl ? await pdf.embedFont(a.arabicBold, { subset: false }) : carlitoBold;
  if (rtl) shapedFaces.set(arabicBold, shaperFor(a.arabicBold));

  const wordmark = await pdf.embedPng(a.wordmark);
  const qr = await pdf.embedPng(a.qr);
  const leaf = await pdf.embedPng(a.leaf);
  const leafDot = await pdf.embedPng(a.leafDot);

  /** Body text: Arabic runs use Noto, Latin runs stay on Carlito. */
  const body: FontPair = { rtl: arabicBold, ltr: carlitoBold };
  const clean = makeSanitizer([carlitoBold, arabicBold]);
  const cleanAccent = makeSanitizer([accent]);

  pdf.setTitle(foodListTitle(language));
  pdf.setSubject(foodListSubtitle(language));
  pdf.setProducer("NutriClinic");
  pdf.setCreator("NutriClinic");

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  // PDF pages are transparent by default; paint the sheet white so the form looks
  // the same when it's rasterised or composited, not just in a viewer that
  // happens to draw a white backdrop.
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: WHITE });
  const ticked = new Set(input.selections);

  drawHeader(page, { wordmark, qr, leafDot, accent });
  drawTitleBlock(page, { body, accentBold, language, rtl });
  drawCategories(page, { body, leaf, ticked, layout, language, rtl });
  drawFields(page, { body, leaf, clean, input, layout, rtl, language });
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

  // The specialities strip: four labels separated by small leaves. The document
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
  {
    body,
    accentBold,
    language,
    rtl,
  }: { body: FontPair; accentBold: PDFFont; language: FoodListLanguage; rtl: boolean },
) {
  const title = foodListTitle(language);
  drawLine(page, title, {
    anchorX: pt(TITLE_CENTER_X) - measure(title, body, SZ_TITLE, rtl) / 2,
    baselineY: yFromTop(TITLE_BASELINE),
    size: SZ_TITLE,
    fonts: body,
    color: TEAL_TEXT,
    // Centred text is positioned by its own measured width, so it is laid out
    // left-to-right from that origin regardless of the script.
    baseRtl: false,
  });
  const subtitle = foodListSubtitle(language);
  // The English subtitle is Lato; the Arabic one needs the Arabic face.
  const subFonts: FontPair = rtl ? body : { rtl: accentBold, ltr: accentBold };
  drawLine(page, subtitle, {
    anchorX: pt(TITLE_CENTER_X) - measure(subtitle, subFonts, SZ_SUBTITLE, rtl) / 2,
    baselineY: yFromTop(SUBTITLE_BASELINE),
    size: SZ_SUBTITLE,
    fonts: subFonts,
    color: TEAL_TEXT,
    baseRtl: false,
  });
}

function drawCategories(
  page: PDFPage,
  {
    body,
    leaf,
    ticked,
    layout,
    language,
    rtl,
  }: {
    body: FontPair;
    leaf: PDFImage;
    ticked: Set<string>;
    layout: LayoutSpec;
    language: FoodListLanguage;
    rtl: boolean;
  },
) {
  for (const category of FOOD_LIST_CATEGORIES) {
    const geo = layout.categories[category.id];
    if (!geo) continue;
    const { box } = geo;

    // Leaf-bulleted heading, sitting above its box. In RTL the leaf is on the
    // right of the heading and the text runs leftwards from it.
    page.drawImage(leaf, {
      x: pt(rtl ? geo.leafX - LEAF_SIZE : geo.leafX),
      y: yFromTop(geo.headingBaseline) - 1,
      width: pt(LEAF_SIZE),
      height: pt(LEAF_SIZE),
    });
    const headingAnchor = rtl
      ? geo.leafX - LEAF_SIZE - LEAF_TEXT_GAP
      : geo.leafX + LEAF_SIZE + LEAF_TEXT_GAP;
    const title = categoryTitle(category, language);
    // A heading too wide for its column wraps on the paper form ("Plant-based
    // proteins"); wrapping here reproduces that rather than letting it overrun.
    const headingWidth = rtl
      ? pt(headingAnchor - box.x)
      : pt(box.x + box.w - headingAnchor);
    const headingLines = wrapText(title, body, SZ_HEADING, headingWidth, rtl, pt(box.w));
    headingLines.forEach((line, i) => {
      drawLine(page, line, {
        anchorX: pt(i === 0 ? headingAnchor : rtl ? box.x + box.w : box.x),
        baselineY: yFromTop(geo.headingBaseline + i * 0.24),
        size: SZ_HEADING,
        fonts: body,
        color: TEAL_TEXT,
        baseRtl: rtl,
      });
    });

    // Lay the items out first: the box is then drawn tall enough to contain them
    // with the document's bottom inset intact, so a label can never be clipped by
    // or crowd against the border.
    const lineHeight =
      layout.itemLineHeightPt ?? body.rtl.heightAtSize(SZ_ITEM, { descender: true });
    const pitch = lineHeight * (layout.lineSpacing[category.id] ?? 1);
    const ascent = layout.itemAscentPt ?? body.rtl.heightAtSize(SZ_ITEM, { descender: false });

    // Checkbox hugs the box's leading edge — left in LTR, right in RTL — and the
    // label starts one gap inboard of it.
    const checkboxX = rtl
      ? pt(box.x + box.w - BOX_INSET_X) - CHECKBOX_SIZE
      : pt(box.x + BOX_INSET_X);
    const labelAnchor = rtl ? checkboxX - CHECKBOX_GAP : checkboxX + CHECKBOX_SIZE + CHECKBOX_GAP;
    const farEdge = rtl ? pt(box.x + BOX_INSET_X) : pt(box.x + box.w - BOX_INSET_X);
    const firstLineW = Math.abs(farEdge - labelAnchor);
    const restLineW = pt(box.w) - pt(BOX_INSET_X) * 2;
    const restAnchor = rtl ? pt(box.x + box.w - BOX_INSET_X) : pt(box.x + BOX_INSET_X);

    const rows = category.items.map((item) => ({
      item,
      lines: wrapText(itemLabel(item, language), body, SZ_ITEM, firstLineW, rtl, restLineW),
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
      drawCheckboxAt(page, checkboxX, firstBaselineY - line * pitch, ticked.has(item.id));
      lines.forEach((text, i) => {
        drawLine(page, text, {
          anchorX: i === 0 ? labelAnchor : restAnchor,
          baselineY: firstBaselineY - (line + i) * pitch,
          size: SZ_ITEM,
          fonts: body,
          color: ITEM_TEXT,
          baseRtl: rtl,
        });
      });
      line += lines.length;
    }
  }
}

function drawFields(
  page: PDFPage,
  {
    body,
    leaf,
    clean,
    input,
    layout,
    rtl,
    language,
  }: {
    body: FontPair;
    leaf: PDFImage;
    clean: (t: string) => string;
    input: FoodListPdfInput;
    layout: LayoutSpec;
    rtl: boolean;
    language: FoodListLanguage;
  },
) {
  const f = layout.fields;
  const labels = FOOD_LIST_FIELD_LABELS[language];
  const rows: { label: string; baseline: number }[] = [
    { label: labels.name, baseline: f.nameBaseline },
    { label: labels.notes, baseline: f.notesBaseline },
  ];
  for (const row of rows) {
    // Leaf sits outboard of the label: to its left in LTR, to its right in RTL.
    page.drawImage(leaf, {
      x: pt(rtl ? f.labelAnchorX : f.labelAnchorX - LEAF_SIZE - 0.03),
      y: yFromTop(row.baseline) - 1,
      width: pt(LEAF_SIZE),
      height: pt(LEAF_SIZE),
    });
    drawLine(page, row.label, {
      anchorX: pt(rtl ? f.labelAnchorX - LEAF_SIZE - 0.03 : f.labelAnchorX),
      baselineY: yFromTop(row.baseline),
      size: SZ_FIELD,
      fonts: body,
      color: TEAL_TEXT,
      baseRtl: rtl,
    });
    page.drawLine({
      start: { x: pt(f.ruleX0), y: yFromTop(row.baseline) - 3 },
      end: { x: pt(f.ruleX1), y: yFromTop(row.baseline) - 3 },
      thickness: 1,
      color: RULE,
    });
  }

  // Values sit on their rule, starting from the reading edge.
  const ruleWidth = pt(f.ruleX1 - f.ruleX0) - 8;
  const valueAnchor = rtl ? pt(f.ruleX1) - 4 : pt(f.ruleX0) + 4;

  const name = clean(input.patientName).trim();
  if (name) {
    const fitted = fitText(name, body, ruleWidth, 1, [14, 13, 12, 11, 10, 9], rtl);
    drawLine(page, fitted.lines[0], {
      anchorX: valueAnchor,
      baselineY: yFromTop(f.nameBaseline),
      size: fitted.size,
      fonts: body,
      color: ITEM_TEXT,
      baseRtl: rtl,
    });
  }

  const notes = clean(input.notes ?? "").trim();
  if (notes) {
    // The paper form gives Notes one rule; allow a second line in the gap above
    // the footer before truncating, so a longer note still prints in full.
    const fitted = fitText(notes, body, ruleWidth, 2, [13, 12, 11, 10, 9, 8.5], rtl);
    fitted.lines.forEach((text, i) => {
      drawLine(page, text, {
        anchorX: valueAnchor,
        baselineY: yFromTop(f.notesBaseline + i * 0.19),
        size: fitted.size,
        fonts: body,
        color: ITEM_TEXT,
        baseRtl: rtl,
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
