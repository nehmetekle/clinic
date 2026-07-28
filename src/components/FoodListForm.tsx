"use client";

import { Download, FileText, Languages, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import {
  categoryTitle,
  FOOD_LIST_CATEGORIES,
  FOOD_LIST_FIELD_LABELS,
  FOOD_LIST_FOOTER,
  FOOD_LIST_ITEM_COUNT,
  FOOD_LIST_SPECIALITIES,
  foodListSubtitle,
  foodListTitle,
  isRtl,
  itemLabel,
  type FoodListLanguage,
} from "@/lib/food-list";
import type { ConsultationFile } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The editable state the consultation editor holds for this form. */
export type FoodListDraft = {
  patientName: string;
  notes: string;
  selections: string[];
};

// Colours lifted from the paper form so the on-screen version reads as the same
// document (see src/server/pdf/food-list-pdf.ts, which prints these exact values).
const BAND = "#2F5F5C";
const FOOTER_BAR = "#2D6664";
const TEAL_TEXT = "#2E6666";
const ITEM_TEXT = "#273D3C";

/**
 * The language gate shown when the card is first opened. Both editions reproduce
 * the clinic's paper form; the choice is stored on the visit and decides which
 * labels are shown here and which layout the PDF prints (the Arabic sheet is a
 * mirrored, right-to-left version of the same 94 items).
 */
export function FoodListLanguagePicker({
  onSelect,
}: {
  onSelect: (language: FoodListLanguage) => void;
}) {
  return (
    <div>
      <p className="mb-3 flex items-center gap-2 text-sm text-slate-500">
        <Languages className="h-4 w-4 text-slate-400" />
        Choose the version of the form to fill in.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onSelect("en")}
          className="group rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40"
        >
          <span className="block text-sm font-semibold text-slate-800 group-hover:text-brand-700">
            English
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelect("ar")}
          className="group rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40"
        >
          <span className="block text-sm font-semibold text-slate-800 group-hover:text-brand-700">
            Arabic — العربية
          </span>
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        The two versions share the same items, so ticks carry over if you switch.
      </p>
    </div>
  );
}

/**
 * The Nutrient-Rich Foods List as an on-screen form, styled to read as the same
 * document the clinic uses on paper (teal header band, branded title block, leaf
 * headings, teal footer) while reflowing responsively — the printed form is four
 * columns, which is unusable inside the editor card on a narrow screen.
 */
export function FoodListForm({
  draft,
  language,
  onChange,
  onChangeLanguage,
  onGeneratePdf,
  generating,
  generatedFile,
  canGenerate,
}: {
  draft: FoodListDraft;
  language: FoodListLanguage;
  onChange: (next: FoodListDraft) => void;
  onChangeLanguage: () => void;
  onGeneratePdf: () => void;
  generating: boolean;
  generatedFile?: ConsultationFile;
  canGenerate: boolean;
}) {
  const rtl = isRtl(language);
  const fieldLabels = FOOD_LIST_FIELD_LABELS[language];
  const selected = new Set(draft.selections);
  const toggle = (id: string) =>
    onChange({
      ...draft,
      selections: selected.has(id)
        ? draft.selections.filter((s) => s !== id)
        : [...draft.selections, id],
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {draft.selections.length} of {FOOD_LIST_ITEM_COUNT} items ticked
        </p>
        <button
          type="button"
          onClick={onChangeLanguage}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          <Languages className="h-3.5 w-3.5" /> Change language
        </button>
      </div>

      {/* The form itself, framed like the printed sheet. `dir` flips the whole
          block for Arabic — checkbox to the right of its label, headings and
          fields right-aligned — mirroring how the printed sheet reads. */}
      <div
        dir={rtl ? "rtl" : "ltr"}
        className="overflow-hidden rounded-xl border border-slate-200"
      >
        <div className="px-4 py-4 text-center" style={{ backgroundColor: BAND }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/layaka-wordmark-white.png"
            alt="Layaka Health &amp; Wellness Clinic"
            className="mx-auto h-10 w-auto"
          />
          <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-wide text-white/90">
            {FOOD_LIST_SPECIALITIES.map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                {i > 0 && <span className="text-white/50">•</span>}
                {s}
              </span>
            ))}
          </p>
        </div>

        <div className="bg-white px-4 py-4">
          <h4
            className="text-center text-lg font-bold tracking-tight"
            style={{ color: TEAL_TEXT }}
          >
            {foodListTitle(language)}
          </h4>
          <p className="text-center text-xs font-semibold" style={{ color: TEAL_TEXT }}>
            {foodListSubtitle(language)}
          </p>

          <div className="mt-4 space-y-3 border-y border-slate-100 py-4">
            <label className="block">
              <span
                className="mb-1 flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: TEAL_TEXT }}
              >
                <LeafBullet /> {fieldLabels.name}
              </span>
              <Input
                value={draft.patientName}
                onChange={(e) => onChange({ ...draft, patientName: e.target.value })}
                placeholder="Patient name"
              />
            </label>
            <label className="block">
              <span
                className="mb-1 flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: TEAL_TEXT }}
              >
                <LeafBullet /> {fieldLabels.notes}
              </span>
              <Textarea
                rows={2}
                value={draft.notes}
                onChange={(e) => onChange({ ...draft, notes: e.target.value })}
                placeholder="Anything to note alongside the food list…"
              />
              <span className="mt-1 block text-xs text-slate-400">
                The printed form gives Notes a single ruled line — long notes print
                smaller and run to a second line.
              </span>
            </label>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {FOOD_LIST_CATEGORIES.map((category) => (
              <div key={category.id} className="rounded-lg border border-slate-200 p-3">
                <p
                  className="mb-2 flex items-center gap-1.5 text-sm font-bold"
                  style={{ color: TEAL_TEXT }}
                >
                  <LeafBullet /> {categoryTitle(category, language)}
                </p>
                <div className="space-y-1">
                  {category.items.map((item) => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-start gap-2 text-sm font-medium"
                      style={{ color: ITEM_TEXT }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
                      />
                      <span className="min-w-0 flex-1">{itemLabel(item, language)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p
          className="px-4 py-2 text-center text-[11px] font-medium text-white"
          style={{ backgroundColor: FOOTER_BAR }}
        >
          {FOOD_LIST_FOOTER}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">Printable form</p>
          {generatedFile ? (
            <p className="truncate text-xs text-slate-400">
              Last generated {new Date(generatedFile.createdAt).toLocaleString()} — also on the
              patient&apos;s Files tab.
            </p>
          ) : (
            <p className="text-xs text-slate-400">
              Generates a PDF of this form and attaches it to the visit.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {generatedFile && (
            <a
              href={`/api/consultation-files/${generatedFile.id}`}
              download={generatedFile.filename}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
            >
              <Download className="h-4 w-4" /> Download
            </a>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={onGeneratePdf}
            disabled={generating || !canGenerate}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            {generatedFile ? "Regenerate PDF" : "Generate PDF"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The teal leaf that bullets every heading on the paper form. */
function LeafBullet({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/images/layaka-leaf.png" alt="" aria-hidden className={cn("h-4 w-4", className)} />;
}
