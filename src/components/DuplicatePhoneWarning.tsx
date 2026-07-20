"use client";

import Link from "next/link";
import { AlertTriangle, ExternalLink, Phone } from "lucide-react";
import type { Client } from "@/lib/types";

/**
 * Amber "possible duplicate" panel shown when an entered phone matches existing
 * patient(s). Warn-don't-block: it never prevents registration — family members
 * may share a line — it just lets staff recognise an existing patient and jump to
 * their profile, or (phone booking, via `onSelect`) book for them instead.
 */
export function DuplicatePhoneWarning({
  matches,
  onSelect,
}: {
  matches: Client[];
  onSelect?: (client: Client) => void;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {matches.length === 1
          ? "This phone number is already on file"
          : "This phone number matches existing patients"}
      </p>
      <p className="mt-0.5 text-xs text-amber-700">
        Check it isn&apos;t the same person before adding a new patient. You can still
        proceed if they&apos;re genuinely different (e.g. a family member on the same line).
      </p>
      <ul className="mt-2 space-y-1.5">
        {matches.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2.5 py-1.5"
          >
            <span>
              <span className="font-medium text-slate-800">
                {c.firstName} {c.lastName}
              </span>
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-slate-500">
                <Phone className="h-3 w-3" /> {c.phone}
              </span>
            </span>
            <span className="flex items-center gap-3">
              {onSelect && (
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className="text-xs font-medium text-brand-700 hover:underline"
                >
                  Use this patient
                </button>
              )}
              <Link
                href={`/clients/${c.id}`}
                target="_blank"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                View profile <ExternalLink className="h-3 w-3" />
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
