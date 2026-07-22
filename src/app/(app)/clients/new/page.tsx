"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CountrySelect, FieldGrid, FormRow, Input, PhoneInput, Select, SectionDivider, Textarea, isValidPhone } from "@/components/ui/Field";
import { Loading } from "@/components/ui/States";
import { DuplicatePhoneWarning } from "@/components/DuplicatePhoneWarning";
import { useApi } from "@/lib/use-api";
import { useDuplicatePhone } from "@/lib/use-duplicate-phone";
import { api, DuplicatePhoneError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { Client } from "@/lib/types";
import { cn } from "@/lib/utils";
import { todayIso, NONE_REFERRER } from "@/lib/config";

// Registration captures the patient's details only. Packages/bundles are NOT
// assigned at signup — the dietitian starts a treatment-scoped bundle during a
// consultation instead. The first visit is booked separately from Appointments.

// Red outline for a field that's still needed. Name, phone and reference are
// required to register; date of birth, gender and country are required before
// check-in, so we flag them here too as a heads-up for the secretary.
const missingClass = "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30";

const EMPTY = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  dateOfBirth: "",
  gender: "female",
  address: "",
  emergencyContact: "",
  medicalNotes: "",
  allergies: "",
  passportNumber: "",
  country: "",
  maritalStatus: "single",
  referralSource: "",
  firstTimePatient: false,
  assignedDietitianId: "",
};

export default function NewClientPage() {
  const router = useRouter();
  const { toast } = useToast();
  const staff = useApi(() => api.listStaff());
  const referrers = useApi(() => api.listReferrers());

  const [form, setForm] = useState(EMPTY);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  // Warn-don't-block duplicate detection by phone. `liveMatches` is the live
  // lookup as the number is typed; `serverMatches` catches a race where the
  // server found a duplicate the lookup hadn't returned yet (its 409 carries the
  // matches). Either way the warning is shown and staff may register anyway.
  const liveMatches = useDuplicatePhone(form.phone);
  const [serverMatches, setServerMatches] = useState<Client[]>([]);
  const dupMatches = liveMatches.length > 0 ? liveMatches : serverMatches;

  if (staff.loading) return <Loading />;

  const dietitians = (staff.data ?? []).filter((s) => s.role === "dietitian" && s.status === "active");

  async function finish() {
    setSaving(true);
    try {
      await api.createClient({
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone,
        email: form.email || undefined,
        dateOfBirth: form.dateOfBirth || undefined,
        gender: form.gender,
        address: form.address || undefined,
        emergencyContact: form.emergencyContact || undefined,
        medicalNotes: form.medicalNotes || undefined,
        allergies: form.allergies || undefined,
        passportNumber: form.passportNumber || undefined,
        country: form.country || undefined,
        maritalStatus: form.maritalStatus,
        referralSource: form.referralSource,
        firstTimePatient: form.firstTimePatient,
        assignedDietitianId: form.assignedDietitianId || null,
        // The warning was on screen — clicking Finish is the "register anyway".
        confirmDuplicatePhone: dupMatches.length > 0,
      });
      toast("Client registered");
      setDone(true);
    } catch (e) {
      if (e instanceof DuplicatePhoneError) {
        // Lost the race: surface the server's matches so the warning shows, then
        // a second Finish click resubmits with the duplicate confirmed.
        setServerMatches(e.matches);
        toast("This phone number is already on file — check the highlighted patient.");
      } else {
        toast((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  // Registration needs name, phone and reference; the remaining fields are
  // required later at check-in (enforced on the check-in screen). Referrer is
  // captured up front so we always record who referred the patient.
  // A phone duplicate no longer blocks saving — it only warns (see
  // DuplicatePhoneWarning); staff can register a genuine second patient anyway.
  const canSave =
    form.firstName.trim() !== "" &&
    form.lastName.trim() !== "" &&
    isValidPhone(form.phone) &&
    form.referralSource.trim() !== "";

  if (done) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Check className="h-8 w-8" />
        </div>
        <h2 className="mt-5 text-xl font-semibold text-slate-900">Client registered</h2>
        <p className="mt-2 text-sm text-slate-500">
          The client has been saved to the database.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => router.push("/clients")}>Go to clients</Button>
          <Button variant="outline" onClick={() => router.push("/queue")}>
            View today&apos;s queue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => router.back()}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>
      <PageHeader title="New client registration" subtitle="Workflow 1 — register the patient's details." />

      <Card>
        <CardBody>
          <FieldGrid>
            <div className="sm:col-span-2 flex items-center rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={form.firstTimePatient}
                  onChange={(e) => setForm({ ...form, firstTimePatient: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
                />
                First-time patient
              </label>
            </div>
            {dupMatches.length > 0 && (
              <div className="sm:col-span-2">
                <DuplicatePhoneWarning matches={dupMatches} />
              </div>
            )}
            <FormRow label="First name *"><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="Sara" className={cn(form.firstName.trim() === "" && missingClass)} /></FormRow>
            <FormRow label="Last name *"><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="Khalil" className={cn(form.lastName.trim() === "" && missingClass)} /></FormRow>
            <FormRow label="Phone *"><PhoneInput value={form.phone} onChange={(phone) => { setForm({ ...form, phone }); setServerMatches([]); }} invalid={!isValidPhone(form.phone)} /></FormRow>
          </FieldGrid>

          <SectionDivider label="Additional information" />

          <FieldGrid>
            <FormRow label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@email.com" /></FormRow>
            <FormRow label="Date of birth"><Input type="date" min="1900-01-01" max={todayIso()} value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} className={cn(form.dateOfBirth === "" && missingClass)} /></FormRow>
            <FormRow label="Gender">
              <Select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className={cn(form.gender === "" && missingClass)}>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            </FormRow>
            <FormRow label="Referrer *">
              <Select value={form.referralSource} onChange={(e) => setForm({ ...form, referralSource: e.target.value })} className={cn(form.referralSource.trim() === "" && missingClass)}>
                <option value="">Select referrer…</option>
                <option value={NONE_REFERRER}>None</option>
                {(referrers.data ?? []).filter((r) => r.active).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
              </Select>
            </FormRow>
            <FormRow label="Country"><CountrySelect value={form.country} onChange={(country) => setForm({ ...form, country })} invalid={form.country.trim() === ""} /></FormRow>
            <FormRow label="Passport / ID number"><Input value={form.passportNumber} onChange={(e) => setForm({ ...form, passportNumber: e.target.value })} placeholder="e.g. RL1234567" /></FormRow>
            <FormRow label="Marital status">
              <Select value={form.maritalStatus} onChange={(e) => setForm({ ...form, maritalStatus: e.target.value })}>
                <option value="single">Single</option>
                <option value="married">Married</option>
                <option value="divorced">Divorced</option>
                <option value="widowed">Widowed</option>
                <option value="other">Other</option>
              </Select>
            </FormRow>
            <FormRow label="Assigned dietitian">
              <Select value={form.assignedDietitianId} onChange={(e) => setForm({ ...form, assignedDietitianId: e.target.value })}>
                <option value="">Unassigned</option>
                {dietitians.map((dt) => (
                  <option key={dt.id} value={dt.id}>{dt.fullName}</option>
                ))}
              </Select>
            </FormRow>
            <FormRow label="Address" className="sm:col-span-2"><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="City, area" /></FormRow>
            <FormRow label="Emergency contact" className="sm:col-span-2"><Input value={form.emergencyContact} onChange={(e) => setForm({ ...form, emergencyContact: e.target.value })} placeholder="Name + phone" /></FormRow>
            <FormRow label="Medical notes" className="sm:col-span-2"><Textarea rows={2} value={form.medicalNotes} onChange={(e) => setForm({ ...form, medicalNotes: e.target.value })} placeholder="Conditions, medication…" /></FormRow>
            <FormRow label="Allergies / restrictions" className="sm:col-span-2"><Input value={form.allergies} onChange={(e) => setForm({ ...form, allergies: e.target.value })} placeholder="e.g. lactose intolerant" /></FormRow>
          </FieldGrid>
        </CardBody>
        <div className="flex items-center justify-end border-t border-slate-100 px-5 py-4">
          <Button onClick={finish} disabled={saving || !canSave}>
            {saving ? "Saving…" : "Finish registration"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
