"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, Phone, Search, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FieldGrid, FormRow, Input, PhoneInput, Select, WeekdayDateInput, isValidPhone } from "@/components/ui/Field";
import { Loading } from "@/components/ui/States";
import { DuplicatePhoneWarning } from "@/components/DuplicatePhoneWarning";
import { useApi } from "@/lib/use-api";
import { useSession } from "@/lib/session";
import { useClientSearch } from "@/lib/use-client-search";
import { useDuplicatePhone } from "@/lib/use-duplicate-phone";
import { api, DuplicatePhoneError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { todayIso } from "@/lib/config";
import { cn, defaultSlot, formatTime, timeSlots } from "@/lib/utils";
import { VISIT_TYPE_LABELS, VISIT_TYPE_VALUES } from "@/lib/types";
import type { Client, VisitType } from "@/lib/types";

const SLOTS = timeSlots();

// Red outline for a required field that hasn't been answered yet.
const missingClass = "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30";

// Date today, time = next available 30-minute slot based on the current clock.
const initialSlot = defaultSlot(todayIso());
const BOOKING_DEFAULT = {
  dietitianId: "",
  date: initialSlot.date,
  time: initialSlot.time,
  visitType: "follow_up" as VisitType,
};

const NEW_PATIENT_DEFAULT = { firstName: "", lastName: "", phone: "", referralSource: "" };

type Mode = "search" | "new";

export default function PhoneBookingPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useSession();
  // Dietitians can't book appointments — bounce them back if they land here directly.
  const bookingAllowed = user?.role !== "dietitian";
  useEffect(() => {
    if (!bookingAllowed) router.replace("/appointments");
  }, [bookingAllowed, router]);
  const staff = useApi(() => api.listStaff());
  const referrers = useApi(() => api.listReferrers());
  const dietitians = (staff.data ?? []).filter((s) => s.role === "dietitian");

  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<Mode>("search");

  // Search for an existing patient to book (shared server-side, debounced hook).
  const [q, setQ] = useState("");
  const { results: matches, loading: searching } = useClientSearch(q, { minChars: 1 });
  const [selected, setSelected] = useState<Client | null>(null);

  // New patient (quick phone booking — minimal details, completed at check-in).
  const [newPatient, setNewPatient] = useState(NEW_PATIENT_DEFAULT);

  // Warn-don't-block duplicate detection while entering a new patient's phone.
  // `serverMatches` catches a race where the create's 409 carries matches the
  // live lookup hadn't returned yet. Only active in "new" mode.
  const liveMatches = useDuplicatePhone(mode === "new" ? newPatient.phone : "");
  const [serverMatches, setServerMatches] = useState<Client[]>([]);
  const dupMatches = liveMatches.length > 0 ? liveMatches : serverMatches;

  const [booking, setBooking] = useState(BOOKING_DEFAULT);

  if (!bookingAllowed) return <Loading />;
  if (staff.loading) return <Loading />;

  const newPatientValid =
    newPatient.firstName.trim() !== "" &&
    newPatient.lastName.trim() !== "" &&
    newPatient.referralSource.trim() !== "" &&
    isValidPhone(newPatient.phone);

  const canBook = saving ? false : mode === "search" ? !!selected : newPatientValid;
  // Show the appointment fields once we know who we're booking for.
  const showAppointment = mode === "search" ? !!selected : true;

  function goToSearch() {
    setMode("search");
    setSelected(null);
    setServerMatches([]);
  }

  function goToNew() {
    setMode("new");
    setSelected(null);
    setServerMatches([]);
  }

  // From the duplicate warning: book for the existing patient instead of creating
  // a new one. Switches to search mode with that patient pre-selected.
  function selectExistingPatient(client: Client) {
    setSelected(client);
    setMode("search");
    setServerMatches([]);
  }

  // "Add as new patient" from an empty search — carry over what was typed.
  function startNewFromQuery() {
    const term = q.trim();
    const looksLikePhone = /[0-9+]/.test(term) && !/[a-zA-Z]/.test(term);
    setNewPatient({
      firstName: looksLikePhone ? "" : term,
      lastName: "",
      phone: looksLikePhone ? term : "",
      referralSource: "",
    });
    setMode("new");
    setSelected(null);
  }

  async function book() {
    if (booking.date < todayIso()) {
      toast("Appointments can't be booked for a past date.");
      return;
    }
    setSaving(true);
    try {
      let clientId: string;
      let name: string;

      if (mode === "new") {
        const first = newPatient.firstName.trim();
        const last = newPatient.lastName.trim();
        // A phone booking captures only name + phone. Check-in still completes
        // the required registration details before the appointment moves ahead.
        const client = await api.createClient({
          firstName: first,
          lastName: last,
          phone: newPatient.phone,
          referralSource: newPatient.referralSource,
          assignedDietitianId: booking.dietitianId || null,
          firstTimePatient: true,
          // The warning was on screen — clicking Book is the "add anyway".
          confirmDuplicatePhone: dupMatches.length > 0,
        });
        clientId = client.id;
        name = `${first} ${last}`;
      } else {
        if (!selected) return;
        clientId = selected.id;
        name = `${selected.firstName} ${selected.lastName}`;
      }

      await api.createAppointment({
        clientId,
        dietitianId: booking.dietitianId || null,
        date: booking.date,
        time: booking.time,
        visitType: booking.visitType,
      });
      toast(`Appointment booked for ${name}`);
      router.push("/appointments");
    } catch (e) {
      if (e instanceof DuplicatePhoneError) {
        // Lost the race: surface the server's matches so the warning shows, then
        // a second Book click resubmits with the duplicate confirmed.
        setServerMatches(e.matches);
        toast("This phone number is already on file — check the highlighted patient.");
      } else {
        toast((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <button
        onClick={() => router.back()}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>
      <PageHeader
        title="Schedule appointment"
        subtitle="Find an existing patient or add a new one, then pick a time slot."
      />

      <Card>
        <CardHeader
          title="Who is the appointment for?"
          subtitle="Search for an existing patient, or register a new one with their basic details."
        />
        <CardBody>
          {/* Existing / New toggle */}
          <div className="mb-5 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={goToSearch}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                mode === "search" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
            >
              <Search className="mr-1.5 inline h-3.5 w-3.5" /> Existing patient
            </button>
            <button
              type="button"
              onClick={goToNew}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                mode === "new" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700",
              )}
            >
              <UserPlus className="mr-1.5 inline h-3.5 w-3.5" /> New patient
            </button>
          </div>

          {mode === "search" ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  autoFocus
                  className="pl-9"
                  placeholder="Phone number or name…"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setSelected(null);
                  }}
                />
              </div>

              {q.trim() === "" ? (
                <p className="mt-4 text-sm text-slate-400">Start typing a phone number or a name.</p>
              ) : searching ? (
                <p className="mt-4 text-sm text-slate-400">Searching…</p>
              ) : matches.length === 0 ? (
                <div className="mt-4 flex flex-col items-start gap-3">
                  <p className="text-sm text-slate-400">No patient matches “{q.trim()}”.</p>
                  <Button variant="outline" size="sm" onClick={startNewFromQuery}>
                    <UserPlus className="h-4 w-4" /> Add “{q.trim()}” as a new patient
                  </Button>
                </div>
              ) : (
                <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => setSelected(c)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors",
                          selected?.id === c.id ? "bg-brand-50" : "hover:bg-slate-50",
                        )}
                      >
                        <span>
                          <span className="block text-sm font-medium text-slate-800">
                            {c.firstName} {c.lastName}
                          </span>
                          <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Phone className="h-3 w-3" /> {c.phone}
                          </span>
                        </span>
                        {selected?.id === c.id && <Check className="h-4 w-4 text-brand-600" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {selected && (
                <div className="mt-5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  Booking for <span className="font-medium">{selected.firstName} {selected.lastName}</span> · {selected.phone}
                </div>
              )}
            </>
          ) : (
            <>
              <FieldGrid>
                <FormRow label="First name *">
                  <Input
                    autoFocus
                    value={newPatient.firstName}
                    onChange={(e) => setNewPatient({ ...newPatient, firstName: e.target.value })}
                    placeholder="First name"
                  />
                </FormRow>
                <FormRow label="Last name *">
                  <Input
                    value={newPatient.lastName}
                    onChange={(e) => setNewPatient({ ...newPatient, lastName: e.target.value })}
                    placeholder="Last name"
                  />
                </FormRow>
                <FormRow label="Phone *">
                  <PhoneInput
                    value={newPatient.phone}
                    onChange={(phone) => {
                      setNewPatient({ ...newPatient, phone });
                      setServerMatches([]);
                    }}
                    invalid={newPatient.phone !== "" && !isValidPhone(newPatient.phone)}
                  />
                </FormRow>
                <FormRow label="Referrer *">
                  <Select
                    value={newPatient.referralSource}
                    onChange={(e) => setNewPatient({ ...newPatient, referralSource: e.target.value })}
                    className={cn(newPatient.referralSource.trim() === "" && missingClass)}
                  >
                    <option value="">Select referrer…</option>
                    {(referrers.data ?? []).filter((r) => r.active).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </Select>
                </FormRow>
              </FieldGrid>
              {dupMatches.length > 0 && (
                <div className="mt-4">
                  <DuplicatePhoneWarning matches={dupMatches} onSelect={selectExistingPatient} />
                </div>
              )}
              <p className="mt-3 text-xs text-slate-400">
                Name, phone and referrer are all that&apos;s needed to book — the remaining
                details are completed at check-in when the patient arrives.
              </p>
            </>
          )}

          {showAppointment && (
            <div className="mt-5 border-t border-slate-100 pt-5">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Appointment</p>
              <FieldGrid>
                <FormRow label="Date"><WeekdayDateInput min={todayIso()} value={booking.date} onChange={(v) => setBooking({ ...booking, date: v })} /></FormRow>
                <FormRow label="Time slot">
                  <Select value={booking.time} onChange={(e) => setBooking({ ...booking, time: e.target.value })}>
                    {SLOTS.map((t) => <option key={t} value={t}>{formatTime(t)}</option>)}
                  </Select>
                </FormRow>
                <FormRow label="Dietitian">
                  <Select value={booking.dietitianId} onChange={(e) => setBooking({ ...booking, dietitianId: e.target.value })}>
                    <option value="">Select dietitian…</option>
                    {dietitians.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
                  </Select>
                </FormRow>
                <FormRow label="Visit type">
                  <Select value={booking.visitType} onChange={(e) => setBooking({ ...booking, visitType: e.target.value as VisitType })}>
                    {VISIT_TYPE_VALUES.map((v) => <option key={v} value={v}>{VISIT_TYPE_LABELS[v]}</option>)}
                  </Select>
                </FormRow>
              </FieldGrid>
            </div>
          )}
        </CardBody>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
          <Button onClick={book} disabled={!canBook}>
            <Check className="h-4 w-4" /> {saving ? "Saving…" : "Book appointment"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
