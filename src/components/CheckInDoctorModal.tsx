"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Stethoscope, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { StaffUser } from "@/lib/types";

// Initials for a doctor avatar, first + last word of the name.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/**
 * The check-in confirmation gate: the secretary must lock in which doctor the
 * patient is being seen by before they enter the clinic, because that decides
 * whose queue the patient shows up in.
 *
 * Two shapes, one mandatory outcome:
 *  - A doctor is already on the appointment (booked, or the client's regular
 *    doctor) → lead with a big "Check in to Dr. X" and tuck the full list behind
 *    a "Choose a different doctor" toggle.
 *  - No doctor yet → open straight to the required picker; confirm stays disabled
 *    until one is chosen. Check-in cannot proceed without a doctor either way.
 */
export function CheckInDoctorModal({
  open,
  onClose,
  clientName,
  doctors,
  defaultDoctorId,
  confirming,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  clientName: string;
  doctors: StaffUser[];
  defaultDoctorId: string | null;
  confirming: boolean;
  onConfirm: (doctorId: string) => void;
}) {
  // A default only counts if it's a currently-active doctor; a stale/inactive one
  // is treated as "no doctor" so the secretary is forced to pick a real one.
  const defaultDoctor = useMemo(
    () => doctors.find((d) => d.id === defaultDoctorId) ?? null,
    [doctors, defaultDoctorId],
  );

  const [selectedId, setSelectedId] = useState<string>(defaultDoctor?.id ?? "");
  // Open the list immediately when there's no confirmed default to fall back on.
  const [picking, setPicking] = useState<boolean>(!defaultDoctor);

  if (!open) return null;

  const chosen = doctors.find((d) => d.id === selectedId) ?? null;
  const canConfirm = !!chosen && !confirming;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header band — clearly frames this as the moment the patient enters the clinic. */}
        <div className="bg-gradient-to-br from-brand-600 to-brand-500 px-6 py-5 text-white">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-white/80">
            <Stethoscope className="h-4 w-4" /> Confirm doctor
          </div>
          <h3 className="mt-1.5 text-lg font-semibold leading-tight">
            Which doctor is {clientName} seeing?
          </h3>
          <p className="mt-1 text-sm text-white/80">
            The patient will appear in this doctor&rsquo;s queue only.
          </p>
        </div>

        <div className="px-6 py-5">
          {/* Default doctor hero: the one-tap happy path. */}
          {defaultDoctor && !picking && (
            <div>
              <button
                type="button"
                onClick={() => setSelectedId(defaultDoctor.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border-2 p-4 text-left transition",
                  selectedId === defaultDoctor.id
                    ? "border-brand-500 bg-brand-50/60 ring-2 ring-brand-500/20"
                    : "border-slate-200 hover:border-slate-300",
                )}
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                  {initials(defaultDoctor.fullName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-slate-800">
                    {defaultDoctor.fullName}
                  </span>
                  <span className="text-xs text-slate-500">Booked for this visit</span>
                </span>
                {selectedId === defaultDoctor.id && (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white">
                    <Check className="h-4 w-4" />
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setPicking(true)}
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-brand-600"
              >
                <ChevronDown className="h-4 w-4" /> Choose a different doctor
              </button>
            </div>
          )}

          {/* Full doctor list — required picker (no default) or the "different doctor" view. */}
          {(!defaultDoctor || picking) && (
            <div>
              {!defaultDoctor && (
                <p className="mb-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                  <UserRound className="h-3.5 w-3.5 shrink-0" />
                  No doctor was set at booking — pick one to check the patient in.
                </p>
              )}
              {doctors.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">
                  No active doctors available.
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {doctors.map((d) => {
                    const active = selectedId === d.id;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setSelectedId(d.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition",
                          active
                            ? "border-brand-500 bg-brand-50/60 ring-2 ring-brand-500/20"
                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                            active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600",
                          )}
                        >
                          {initials(d.fullName)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                          {d.fullName}
                        </span>
                        {active && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={confirming}>
            Cancel
          </Button>
          <Button onClick={() => chosen && onConfirm(chosen.id)} disabled={!canConfirm}>
            <Check className="h-4 w-4" />
            {confirming
              ? "Checking in…"
              : chosen
                ? `Check in to ${chosen.fullName}`
                : "Select a doctor"}
          </Button>
        </div>
      </div>
    </div>
  );
}
