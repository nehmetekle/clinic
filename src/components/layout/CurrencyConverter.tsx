"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

type Code = "USD" | "EUR" | "LBP";

const CODES: Code[] = ["USD", "EUR", "LBP"];

const DECIMALS: Record<Code, number> = { USD: 2, EUR: 2, LBP: 0 };

// Group the digits the user is typing (1000000 -> "1,000,000") so a long LBP
// figure stays readable. Keeps a trailing "." and any decimals as typed, so the
// field never fights the keyboard mid-entry.
function groupDigits(raw: string) {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const grouped = whole === "" ? "" : Number(whole).toLocaleString("en-US");
  return rest.length > 0 ? `${grouped}.${rest.join("")}` : grouped;
}

function format(amount: number, code: Code) {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: DECIMALS[code],
    maximumFractionDigits: DECIMALS[code],
  });
}

// One converter instead of two read-only rate chips: pick the currency you have,
// type an amount, read the others off. There is no "to" picker on purpose — with
// three currencies, showing the other two is both fewer controls and more answer.
// Everything goes through USD because that is what the admin-entered rates
// (Pricing) are expressed in.
export function CurrencyConverter() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("1");
  const [base, setBase] = useState<Code>("USD");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const settings = useApi(() => api.getSettings());

  // Keep the rates live for every signed-in user: an admin's change in Pricing
  // shows up in others' converters without a manual reload. Background-refetch on
  // a 60s poll and whenever the tab regains focus/visibility (so a returning user
  // converts at the current rate, not on the next tick).
  const refetchSettings = settings.refetch;
  useEffect(() => {
    const id = setInterval(refetchSettings, 60_000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refetchSettings();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // refetchSettings is stable for the lifetime of the mounted hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.select();
  }, [open]);

  const usdToLbp = settings.data?.usdToLbp;
  const usdToEur = settings.data?.usdToEur;

  // Value of one USD in each currency.
  const perUsd = useMemo<Partial<Record<Code, number>>>(
    () => ({
      USD: 1,
      ...(usdToEur ? { EUR: usdToEur } : {}),
      ...(usdToLbp ? { LBP: usdToLbp } : {}),
    }),
    [usdToEur, usdToLbp],
  );

  const available = CODES.filter((c) => perUsd[c] !== undefined);
  const parsed = Number(amount.replace(/,/g, ""));
  const baseRate = perUsd[base];
  const inUsd =
    Number.isFinite(parsed) && amount.trim() !== "" && baseRate ? parsed / baseRate : null;

  const others = available.filter((c) => c !== base);
  const headline = others[0];
  const headlineRate =
    headline && baseRate ? (perUsd[headline] as number) / baseRate : null;

  if (available.length < 2) return null;

  return (
    <div ref={ref} className="relative hidden lg:block">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium tabular-nums tracking-tight text-slate-500 transition hover:bg-slate-100/80 hover:text-slate-700",
          open && "bg-slate-100 text-slate-700",
        )}
        aria-expanded={open}
        aria-label="Currency converter"
        title="Currency converter"
      >
        <ArrowRightLeft className="h-3.5 w-3.5 text-slate-400" />
        {headline && headlineRate !== null ? (
          <span className="whitespace-nowrap">
            1 {base} <span className="text-slate-300">·</span>{" "}
            <span className="text-slate-700">{format(headlineRate, headline)}</span> {headline}
          </span>
        ) : (
          <span>Convert</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[19rem] overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xl shadow-slate-900/[0.07]">
          <div className="px-5 pb-4 pt-4">
            <div className="flex gap-1 rounded-full bg-slate-100/80 p-0.5">
              {available.map((c) => (
                <button
                  key={c}
                  onClick={() => setBase(c)}
                  className={cn(
                    "flex-1 rounded-full px-2 py-1 text-[11px] font-semibold tracking-wide transition",
                    c === base
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-400 hover:text-slate-600",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-baseline gap-2">
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  const el = e.target;
                  // Re-grouping shifts the text, so re-place the caret by counting
                  // the digits before it rather than trusting the raw offset.
                  const digitsBefore = el.value
                    .slice(0, el.selectionStart ?? el.value.length)
                    .replace(/[^\d.]/g, "").length;
                  const next = groupDigits(el.value);
                  setAmount(next);
                  requestAnimationFrame(() => {
                    let seen = 0;
                    let pos = next.length;
                    for (let i = 0; i < next.length; i++) {
                      if (/[\d.]/.test(next[i])) seen++;
                      if (seen === digitsBefore) {
                        pos = i + 1;
                        break;
                      }
                    }
                    if (digitsBefore === 0) pos = 0;
                    el.setSelectionRange(pos, pos);
                  });
                }}
                placeholder="0"
                aria-label={`Amount in ${base}`}
                className="w-full min-w-0 border-none bg-transparent p-0 text-2xl font-semibold tabular-nums tracking-tight text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-0"
              />
              <span className="text-xs font-semibold text-slate-400">{base}</span>
            </div>
          </div>

          <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-3" aria-live="polite">
            {inUsd === null ? (
              <p className="py-1 text-sm text-slate-400">Enter an amount.</p>
            ) : (
              <div className="space-y-2">
                {others.map((c) => (
                  <div key={c} className="flex items-baseline justify-between gap-3">
                    <span className="text-[11px] font-semibold tracking-wide text-slate-400">
                      {c}
                    </span>
                    <span className="truncate text-base font-semibold tabular-nums tracking-tight text-slate-800">
                      {format(inUsd * (perUsd[c] as number), c)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="border-t border-slate-100 px-5 py-2 text-[10px] text-slate-400">
            Rates set in Pricing
          </p>
        </div>
      )}
    </div>
  );
}
