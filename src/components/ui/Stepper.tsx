"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// Minimal pill stepper for dialing in a quantity against a hard cap. Collapses
// to a single round "+" when nothing is used yet, and expands into a tight
// [-] count [+] pill once at least one is used — capped at `max` so it's
// never possible to dial past what's actually available.
export function Stepper({
  tone = "emerald",
  used,
  max = Infinity,
  min = 0,
  onChange,
}: {
  tone?: "emerald" | "slate";
  used: number;
  max?: number;
  /** Floor the pill sits at — pass 1 for a "sell N" field that can't go to zero. */
  min?: number;
  onChange: (next: number) => void;
}) {
  const colors =
    tone === "emerald"
      ? "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50";

  if (used === 0 && min === 0) {
    return (
      <button
        type="button"
        aria-label="Use a session"
        disabled={max <= 0}
        onClick={() => onChange(1)}
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          colors,
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center rounded-full border bg-white",
        tone === "emerald" ? "border-emerald-300" : "border-slate-300",
      )}
    >
      <button
        type="button"
        aria-label="Use one fewer"
        disabled={used <= min}
        onClick={() => onChange(used - 1)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-30",
          tone === "emerald" ? "text-emerald-700 hover:bg-emerald-50" : "text-slate-600 hover:bg-slate-100",
        )}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span
        className={cn(
          "min-w-[1.25rem] select-none text-center text-xs font-semibold tabular-nums",
          tone === "emerald" ? "text-emerald-700" : "text-slate-700",
        )}
      >
        {used}
      </span>
      <button
        type="button"
        aria-label="Use one more"
        disabled={used >= max}
        onClick={() => onChange(used + 1)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-30",
          tone === "emerald" ? "text-emerald-700 hover:bg-emerald-50" : "text-slate-600 hover:bg-slate-100",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
