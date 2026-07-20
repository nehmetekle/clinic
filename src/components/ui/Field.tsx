"use client";

import { useEffect, useState } from "react";
import { cn, formatNumberInput, sanitizeNumberInput } from "@/lib/utils";
import { COUNTRIES, COUNTRIES_ORDERED } from "@/lib/countries";
import { isWeekendIso, WEEKEND_BOOKING_MESSAGE } from "@/lib/config";

export function Label({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-slate-600">
      {children}
    </label>
  );
}

const inputBase =
  "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30";

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputBase, className)} {...props} />;
}

/**
 * Date picker for booking appointments. Native `<input type="date">` can't grey
 * out weekend cells, so instead we reject a Saturday/Sunday selection the moment
 * it's made: the value snaps back (parent state is never updated) and a clear
 * inline message appears. The server (Zod) is the real gate — this is the UX
 * guard. Use this in place of a plain `<Input type="date">` anywhere an
 * appointment date is chosen.
 */
export function WeekdayDateInput({
  value,
  onChange,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const [weekendTried, setWeekendTried] = useState(false);
  return (
    <div>
      <Input
        type="date"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (isWeekendIso(next)) {
            setWeekendTried(true);
            return; // reject — clinic closed on weekends; keep the prior value
          }
          setWeekendTried(false);
          onChange(next);
        }}
        className={cn(
          weekendTried && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30",
          className,
        )}
        {...props}
      />
      {weekendTried && <p className="mt-1 text-xs text-rose-600">{WEEKEND_BOOKING_MESSAGE}</p>}
    </div>
  );
}

export function MoneyInput({
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Input
      inputMode="decimal"
      value={formatNumberInput(value)}
      onChange={(e) => onValueChange(sanitizeNumberInput(e.target.value))}
      className={className}
      {...props}
    />
  );
}

const DEFAULT_DIAL = "+961";
// Unique dial codes, longest first so "+961" matches before "+9…" etc.
const SORTED_CODES = Array.from(new Set(COUNTRIES.map((c) => c.dial))).sort(
  (a, b) => b.length - a.length,
);

// Expected national-number digit length per country (min–max), used to cap input
// and validate. e.g. Lebanon is 7–8 digits, UAE 9, US/Canada 10.
const PHONE_RULES: Record<string, { min: number; max: number }> = {
  "+961": { min: 7, max: 8 },
  "+971": { min: 9, max: 9 },
  "+966": { min: 9, max: 9 },
  "+974": { min: 8, max: 8 },
  "+965": { min: 8, max: 8 },
  "+973": { min: 8, max: 8 },
  "+968": { min: 8, max: 8 },
  "+962": { min: 9, max: 9 },
  "+963": { min: 9, max: 9 },
  "+90": { min: 10, max: 10 },
  "+20": { min: 10, max: 10 },
  "+33": { min: 9, max: 9 },
  "+44": { min: 10, max: 10 },
  "+49": { min: 10, max: 11 },
  "+1": { min: 10, max: 10 },
};

const phoneRule = (dial: string) => PHONE_RULES[dial] ?? { min: 6, max: 15 };
const digitsOnly = (s: string) => (s ?? "").replace(/\D/g, "");

function splitPhone(value: string): { dial: string; rest: string } {
  const v = (value ?? "").trim();
  const match = SORTED_CODES.find((code) => v.startsWith(code));
  if (match) return { dial: match, rest: v.slice(match.length).trim() };
  return { dial: DEFAULT_DIAL, rest: v };
}

/** True when the phone has a national number with a valid digit count for its country. */
export function isValidPhone(value: string): boolean {
  const { dial, rest } = splitPhone(value);
  const n = digitsOnly(rest).length;
  const { min, max } = phoneRule(dial);
  return n >= min && n <= max;
}

/**
 * Phone entry with a country-code dropdown (defaults to Lebanon +961) and a
 * number field. Emits a single combined string ("+961 70 000 000"), or "" when
 * the number is empty so required-field checks still work.
 */
const firstCountryForDial = (dial: string) =>
  COUNTRIES_ORDERED.find((c) => c.dial === dial) ?? COUNTRIES_ORDERED[0];

export function PhoneInput({
  value,
  onChange,
  invalid,
  autoFocus,
  placeholder = "70 000 000",
}: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  // Track the selected country (iso2) so shared dial codes (e.g. +1) display right.
  const [iso2, setIso2] = useState(() => firstCountryForDial(splitPhone(value).dial).iso2);
  const dial = COUNTRIES.find((c) => c.iso2 === iso2)?.dial ?? DEFAULT_DIAL;

  // Adopt the code from an externally-set value (e.g. editing an existing patient).
  useEffect(() => {
    if (value) {
      const d = splitPhone(value).dial;
      if (d !== dial) setIso2(firstCountryForDial(d).iso2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Show digits only and cap at the country's max so more can't be typed.
  const number = digitsOnly(splitPhone(value).rest);
  const { max } = phoneRule(dial);
  const emit = (d: string, n: string) => {
    const capped = digitsOnly(n).slice(0, phoneRule(d).max);
    onChange(capped ? `${d} ${capped}` : "");
  };

  return (
    <div>
      <div className="flex gap-2">
        <Select
          value={iso2}
          onChange={(e) => {
            const country = COUNTRIES.find((c) => c.iso2 === e.target.value);
            setIso2(e.target.value);
            if (country) emit(country.dial, number);
          }}
          className="w-44 shrink-0"
        >
          {COUNTRIES_ORDERED.map((c) => (
            <option key={c.iso2} value={c.iso2}>{c.name} ({c.dial})</option>
          ))}
        </Select>
        <Input
          autoFocus={autoFocus}
          inputMode="numeric"
          maxLength={max}
          value={number}
          placeholder={placeholder}
          onChange={(e) => emit(dial, e.target.value)}
          className={cn(invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30")}
        />
      </div>
      {number !== "" && !isValidPhone(value) && (
        <p className="mt-1 text-xs text-rose-600">
          Enter a valid {dial} number ({phoneRule(dial).min === max ? max : `${phoneRule(dial).min}–${max}`} digits).
        </p>
      )}
    </div>
  );
}

/** Country dropdown (full list, Lebanon first). Stores the country name. */
export function CountrySelect({
  value,
  onChange,
  invalid,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30", className)}
    >
      <option value="">Select country…</option>
      {COUNTRIES_ORDERED.map((c) => (
        <option key={c.iso2} value={c.name}>{c.name}</option>
      ))}
    </Select>
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputBase, "appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30",
        className,
      )}
      {...props}
    />
  );
}

/** Standard two-column grid used for every client info form. */
export function FieldGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("grid gap-4 sm:grid-cols-2", className)}>{children}</div>;
}

/** Labeled divider separating the "required" and "additional" field sections. */
export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-slate-100" />
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <div className="h-px flex-1 bg-slate-100" />
    </div>
  );
}

export function FormRow({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
