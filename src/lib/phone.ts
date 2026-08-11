import { COUNTRIES } from "@/lib/countries";

/**
 * Phone number parsing/validation, shared by the client (the `PhoneInput` field)
 * and the server (Zod write validation, WhatsApp link building).
 *
 * This lives in `lib/` rather than inside `components/ui/Field.tsx` because the
 * server needs the same rules: `Field.tsx` is a `"use client"` module, and
 * pulling it into a route handler's import graph would drag React components
 * onto the server for the sake of two pure functions. `Field.tsx` re-exports
 * {@link isValidPhone} so existing `from "@/components/ui/Field"` imports keep
 * working unchanged.
 */

/** The clinic is in Lebanon, so the country dropdown opens on +961. */
export const DEFAULT_DIAL = "+961";

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

export const phoneRule = (dial: string) => PHONE_RULES[dial] ?? { min: 6, max: 15 };
export const digitsOnly = (s: string) => (s ?? "").replace(/\D/g, "");

/**
 * Splits a stored phone into its country code and national number.
 *
 * `explicit` records whether the code was actually written on the value or
 * merely assumed: a bare "70 000 000" parses as Lebanon so the input field and
 * the length check stay usable, but anything that has to dial the number for
 * real (WhatsApp) must refuse to guess — see {@link hasCountryCode}. A leading
 * "00" is accepted as the international prefix and folded to "+".
 */
export function splitPhone(value: string): { dial: string; rest: string; explicit: boolean } {
  const v = (value ?? "").trim().replace(/^00/, "+");
  const match = SORTED_CODES.find((code) => v.startsWith(code));
  if (match) return { dial: match, rest: v.slice(match.length).trim(), explicit: true };
  return { dial: DEFAULT_DIAL, rest: v, explicit: false };
}

/** True when the phone has a national number with a valid digit count for its country. */
export function isValidPhone(value: string): boolean {
  const { dial, rest } = splitPhone(value);
  const n = digitsOnly(rest).length;
  const { min, max } = phoneRule(dial);
  return n >= min && n <= max;
}

/**
 * True when the value carries a country code we recognise ("+961 …" or
 * "00961 …") rather than having one assumed for it. Every phone entered through
 * `PhoneInput` does; a legacy/imported row, or one written by a direct API call,
 * may not — and a national number alone can't be dialled internationally.
 */
export function hasCountryCode(value: string): boolean {
  return splitPhone(value).explicit;
}

/**
 * The server-side write rule: a stored phone must name its country AND have a
 * plausible national number for it. Stricter than {@link isValidPhone}, which
 * tolerates a missing code so the input field can assume Lebanon while typing.
 * `PhoneInput` always emits an explicit code, so no UI path is affected — this
 * only rejects values that bypassed the forms.
 */
export function isValidInternationalPhone(value: string): boolean {
  return hasCountryCode(value) && isValidPhone(value);
}

/** The message shown when a write is rejected for a malformed phone. */
export const PHONE_FORMAT_MESSAGE =
  "Phone must include a country code and a valid number, e.g. +961 70 000 000";
