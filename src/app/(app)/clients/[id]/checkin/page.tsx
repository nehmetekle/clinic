"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CountrySelect, FieldGrid, FormRow, Input, PhoneInput, Select, SectionDivider, Textarea, isValidPhone } from "@/components/ui/Field";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { todayIso } from "@/lib/config";

// Red outline for an empty required field, so the secretary sees what's missing.
const missingClass = "border-rose-400 focus:border-rose-500 focus:ring-rose-500/30";

const EMPTY = {
  firstName: "",
  lastName: "",
  phone: "",
  referralSource: "",
  firstTimePatient: false,
  dateOfBirth: "",
  gender: "",
  country: "",
  email: "",
  address: "",
  emergencyContact: "",
  passportNumber: "",
  maritalStatus: "",
  medicalNotes: "",
  allergies: "",
  assignedDietitianId: "",
};

function CheckInForm() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const apptId = search.get("appt") ?? "";
  // Where to go after check-in (or cancel); the queue board by default.
  const returnTo = search.get("return") || "/queue";
  const { user } = useSession();
  const { toast } = useToast();

  const { data, loading, error } = useApi(() => api.getClient(params.id), [params.id]);
  const staff = useApi(() => api.listStaff());
  const referrers = useApi(() => api.listReferrers());

  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Pre-fill from whatever was captured at booking so the secretary only fills gaps.
  useEffect(() => {
    if (data && !hydrated) {
      const c = data.client;
      setForm({
        firstName: c.firstName ?? "",
        lastName: c.lastName ?? "",
        phone: c.phone ?? "",
        referralSource: c.referralSource ?? "",
        firstTimePatient: c.firstTimePatient ?? false,
        dateOfBirth: c.dateOfBirth ?? "",
        gender: c.gender ?? "",
        country: c.country ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        emergencyContact: c.emergencyContact ?? "",
        passportNumber: c.passportNumber ?? "",
        maritalStatus: c.maritalStatus ?? "",
        medicalNotes: c.medicalNotes ?? "",
        allergies: c.allergies ?? "",
        assignedDietitianId: c.assignedDietitianId ?? "",
      });
      setHydrated(true);
    }
  }, [data, hydrated]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorState message={error ?? "Client not found"} />;

  const client = data.client;
  const dietitians = (staff.data ?? []).filter(
    (s) => s.role === "dietitian" && s.status === "active",
  );

  // The same form serves two flows: initial check-in (intake still incomplete)
  // and post-check-in corrections opened from the profile's Edit button. When
  // an appointment arrival is being processed, keep the check-in wording even
  // for a returning (already-complete) patient.
  const editOnly = client.intakeComplete && !apptId;
  // Once intake is complete the clinical fields belong to the dietitian (and
  // admin) — hide them from the front desk here and omit them from the save,
  // matching the server-side rule.
  const canEditClinical =
    !client.intakeComplete || user?.role === "dietitian" || user?.role === "admin";

  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  // Check-in requires the intake fields (date of birth, gender, country); the
  // edit flow matches registration — only name, phone and referrer are
  // mandatory, so anything left for later can stay empty (flagged in red).
  const intakeFieldsComplete =
    form.dateOfBirth !== "" && form.gender !== "" && form.country.trim() !== "";
  const canProceed =
    form.firstName.trim() !== "" &&
    form.lastName.trim() !== "" &&
    form.referralSource.trim() !== "" &&
    isValidPhone(form.phone) &&
    (editOnly || intakeFieldsComplete);

  async function proceed() {
    if (!canProceed) return;
    setSaving(true);
    try {
      await api.updateClient(params.id, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        referralSource: form.referralSource.trim(),
        firstTimePatient: form.firstTimePatient,
        // Optional fields are sent even when blank so clearing one sticks.
        dateOfBirth: form.dateOfBirth,
        gender: form.gender,
        country: form.country.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        emergencyContact: form.emergencyContact.trim(),
        passportNumber: form.passportNumber.trim(),
        maritalStatus: form.maritalStatus,
        ...(canEditClinical
          ? { medicalNotes: form.medicalNotes.trim(), allergies: form.allergies.trim() }
          : {}),
        assignedDietitianId: form.assignedDietitianId || null,
        // Clearing an intake field (edit flow) sends the record back to
        // intake-incomplete, so the next check-in asks for it again.
        intakeComplete: intakeFieldsComplete,
      });
      if (apptId) await api.setAppointmentStatus(apptId, "checked_in");
      toast(editOnly ? "Patient details updated" : `${form.firstName} checked in`);
      router.push(returnTo);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <button
        onClick={() => router.push(returnTo)}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>
      <PageHeader
        title={`${editOnly ? "Edit details" : "Check-in"} — ${client.firstName} ${client.lastName}`}
        subtitle={
          editOnly
            ? "Correct the patient's registration details. Required fields can't be left empty."
            : "Complete the patient's registration. Required fields must be filled before you can proceed."
        }
      />

      <Card>
        <CardHeader
          title="Patient details"
          subtitle={
            editOnly
              ? "Only name, phone and referrer are required; the rest can be filled in later."
              : "Required fields must be completed to proceed; the rest is optional."
          }
        />
        <CardBody>
          <FieldGrid>
            <div className="sm:col-span-2 flex items-center rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={form.firstTimePatient}
                  onChange={(e) => set({ firstTimePatient: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
                />
                First-time patient
              </label>
            </div>
            <FormRow label="First name *"><Input value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} placeholder="Sara" className={cn(form.firstName.trim() === "" && missingClass)} /></FormRow>
            <FormRow label="Last name *"><Input value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} placeholder="Khalil" className={cn(form.lastName.trim() === "" && missingClass)} /></FormRow>
            <FormRow label="Phone *"><PhoneInput value={form.phone} onChange={(phone) => set({ phone })} invalid={!isValidPhone(form.phone)} /></FormRow>
          </FieldGrid>

          <SectionDivider label="Additional information" />

          <FieldGrid>
            <FormRow label="Email"><Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} placeholder="name@email.com" /></FormRow>
            <FormRow label={editOnly ? "Date of birth" : "Date of birth *"}><Input type="date" min="1900-01-01" max={todayIso()} value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} className={cn(form.dateOfBirth === "" && missingClass)} /></FormRow>
            <FormRow label={editOnly ? "Gender" : "Gender *"}>
              <Select value={form.gender} onChange={(e) => set({ gender: e.target.value })} className={cn(form.gender === "" && missingClass)}>
                <option value="">Select…</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            </FormRow>
            <FormRow label="Referrer *">
              <Select value={form.referralSource} onChange={(e) => set({ referralSource: e.target.value })} className={cn(form.referralSource.trim() === "" && missingClass)}>
                <option value="">Select referrer…</option>
                {(referrers.data ?? []).filter((r) => r.active).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                {/* Preserve the record's current referrer (a legacy free-text value,
                    or one since deactivated/removed) so it still displays and isn't
                    silently overwritten on save. */}
                {form.referralSource.trim() !== "" &&
                  !(referrers.data ?? []).some((r) => r.active && r.name === form.referralSource) && (
                    <option value={form.referralSource}>{form.referralSource}</option>
                  )}
              </Select>
            </FormRow>
            <FormRow label={editOnly ? "Country" : "Country *"}><CountrySelect value={form.country} onChange={(country) => set({ country })} invalid={form.country.trim() === ""} /></FormRow>
            <FormRow label="Passport / ID number"><Input value={form.passportNumber} onChange={(e) => set({ passportNumber: e.target.value })} placeholder="e.g. RL1234567" /></FormRow>
            <FormRow label="Marital status">
              <Select value={form.maritalStatus} onChange={(e) => set({ maritalStatus: e.target.value })}>
                <option value="">Select…</option>
                <option value="single">Single</option>
                <option value="married">Married</option>
                <option value="divorced">Divorced</option>
                <option value="widowed">Widowed</option>
                <option value="other">Other</option>
              </Select>
            </FormRow>
            <FormRow label="Assigned dietitian (seen in clinic)">
              <Select value={form.assignedDietitianId} onChange={(e) => set({ assignedDietitianId: e.target.value })}>
                <option value="">Unassigned</option>
                {dietitians.map((dt) => (
                  <option key={dt.id} value={dt.id}>{dt.fullName}</option>
                ))}
                {/* Preserve a current dietitian who is no longer active so the
                    assignment still displays and isn't silently dropped on save. */}
                {form.assignedDietitianId !== "" &&
                  !dietitians.some((dt) => dt.id === form.assignedDietitianId) && (
                    <option value={form.assignedDietitianId}>{client.assignedDietitian ?? "Current dietitian"}</option>
                  )}
              </Select>
            </FormRow>
            <FormRow label="Address" className="sm:col-span-2"><Input value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder="City, area" /></FormRow>
            <FormRow label="Emergency contact" className="sm:col-span-2"><Input value={form.emergencyContact} onChange={(e) => set({ emergencyContact: e.target.value })} placeholder="Name + phone" /></FormRow>
            {canEditClinical && (
              <>
                <FormRow label="Medical notes" className="sm:col-span-2"><Textarea rows={2} value={form.medicalNotes} onChange={(e) => set({ medicalNotes: e.target.value })} placeholder="Conditions, medication…" /></FormRow>
                <FormRow label="Allergies / restrictions" className="sm:col-span-2"><Input value={form.allergies} onChange={(e) => set({ allergies: e.target.value })} placeholder="e.g. lactose intolerant" /></FormRow>
              </>
            )}
          </FieldGrid>
        </CardBody>
      </Card>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs text-slate-400">
          {canProceed ? "All required fields complete." : "Fill the required (*) fields to continue."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push(returnTo)}>Cancel</Button>
          <Button onClick={proceed} disabled={!canProceed || saving}>
            <Check className="h-4 w-4" />{" "}
            {saving
              ? editOnly ? "Saving…" : "Checking in…"
              : editOnly ? "Save changes" : "Proceed to Check-In"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function CheckInPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CheckInForm />
    </Suspense>
  );
}
