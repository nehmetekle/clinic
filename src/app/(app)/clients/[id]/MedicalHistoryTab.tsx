"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FormRow, Input, Textarea } from "@/components/ui/Field";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import {
  ALCOHOL_FREQUENCY,
  CIGARETTES_PER_DAY,
  EXERCISE_FREQUENCY,
  EXERCISE_TYPES,
  FAMILY_CONDITIONS,
  MEDICAL_CONDITIONS,
  SLEEP_HOURS,
  WATER_GLASSES,
  type MedicalHistory,
} from "@/lib/types";
import type { MedicalHistoryInput } from "@/lib/validation";
import { cn, formatDate } from "@/lib/utils";

type FormState = {
  conditions: string[];
  intoleranceDetail: string;
  conditionsOther: string;
  hasAllergies: boolean | null;
  allergiesDetail: string;
  takingMedications: boolean | null;
  medicationsDetail: string;
  takingSupplements: boolean | null;
  supplementsDetail: string;
  hadSurgeries: boolean | null;
  surgeriesDetail: string;
  familyHistory: string[];
  familyCancerDetail: string;
  familyOther: string;
  drinksWater: boolean | null;
  waterGlasses: string;
  drinksCaffeine: boolean | null;
  drinksAlcohol: boolean | null;
  alcoholFrequency: string;
  smokes: boolean | null;
  cigarettesPerDay: string;
  exercises: boolean | null;
  exerciseType: string;
  exerciseFrequency: string;
  sleepHours: string;
  wakesRested: boolean | null;
  feelsStressed: boolean | null;
  followsDiet: boolean | null;
  snacksFrequently: boolean | null;
  feelsFatigued: boolean | null;
  moodSwings: boolean | null;
};

const EMPTY: FormState = {
  conditions: [],
  intoleranceDetail: "",
  conditionsOther: "",
  hasAllergies: null,
  allergiesDetail: "",
  takingMedications: null,
  medicationsDetail: "",
  takingSupplements: null,
  supplementsDetail: "",
  hadSurgeries: null,
  surgeriesDetail: "",
  familyHistory: [],
  familyCancerDetail: "",
  familyOther: "",
  drinksWater: null,
  waterGlasses: "",
  drinksCaffeine: null,
  drinksAlcohol: null,
  alcoholFrequency: "",
  smokes: null,
  cigarettesPerDay: "",
  exercises: null,
  exerciseType: "",
  exerciseFrequency: "",
  sleepHours: "",
  wakesRested: null,
  feelsStressed: null,
  followsDiet: null,
  snacksFrequently: null,
  feelsFatigued: null,
  moodSwings: null,
};

function fromRecord(m: MedicalHistory): FormState {
  const s = (v?: string) => v ?? "";
  return {
    conditions: m.conditions ?? [],
    intoleranceDetail: s(m.intoleranceDetail),
    conditionsOther: s(m.conditionsOther),
    hasAllergies: m.hasAllergies,
    allergiesDetail: s(m.allergiesDetail),
    takingMedications: m.takingMedications,
    medicationsDetail: s(m.medicationsDetail),
    takingSupplements: m.takingSupplements,
    supplementsDetail: s(m.supplementsDetail),
    hadSurgeries: m.hadSurgeries,
    surgeriesDetail: s(m.surgeriesDetail),
    familyHistory: m.familyHistory ?? [],
    familyCancerDetail: s(m.familyCancerDetail),
    familyOther: s(m.familyOther),
    drinksWater: m.drinksWater,
    waterGlasses: s(m.waterGlasses),
    drinksCaffeine: m.drinksCaffeine,
    drinksAlcohol: m.drinksAlcohol,
    alcoholFrequency: s(m.alcoholFrequency),
    smokes: m.smokes,
    cigarettesPerDay: s(m.cigarettesPerDay),
    exercises: m.exercises,
    exerciseType: s(m.exerciseType),
    exerciseFrequency: s(m.exerciseFrequency),
    sleepHours: s(m.sleepHours),
    wakesRested: m.wakesRested,
    feelsStressed: m.feelsStressed,
    followsDiet: m.followsDiet,
    snacksFrequently: m.snacksFrequently,
    feelsFatigued: m.feelsFatigued,
    moodSwings: m.moodSwings,
  };
}

function toPayload(f: FormState): MedicalHistoryInput {
  const t = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    conditions: f.conditions,
    intoleranceDetail: t(f.intoleranceDetail),
    conditionsOther: t(f.conditionsOther),
    hasAllergies: f.hasAllergies,
    allergiesDetail: t(f.allergiesDetail),
    takingMedications: f.takingMedications,
    medicationsDetail: t(f.medicationsDetail),
    takingSupplements: f.takingSupplements,
    supplementsDetail: t(f.supplementsDetail),
    hadSurgeries: f.hadSurgeries,
    surgeriesDetail: t(f.surgeriesDetail),
    familyHistory: f.familyHistory,
    familyCancerDetail: t(f.familyCancerDetail),
    familyOther: t(f.familyOther),
    drinksWater: f.drinksWater,
    waterGlasses: t(f.waterGlasses),
    drinksCaffeine: f.drinksCaffeine,
    drinksAlcohol: f.drinksAlcohol,
    alcoholFrequency: t(f.alcoholFrequency),
    smokes: f.smokes,
    cigarettesPerDay: t(f.cigarettesPerDay),
    exercises: f.exercises,
    exerciseType: t(f.exerciseType),
    exerciseFrequency: t(f.exerciseFrequency),
    sleepHours: t(f.sleepHours),
    wakesRested: f.wakesRested,
    feelsStressed: f.feelsStressed,
    followsDiet: f.followsDiet,
    snacksFrequently: f.snacksFrequently,
    feelsFatigued: f.feelsFatigued,
    moodSwings: f.moodSwings,
  };
}

// ---------- Edit-mode controls ----------

/** Shared pill-button style used by the Yes/No toggles and the quick-pick rows. */
const pillClass = (active: boolean) =>
  cn(
    "rounded-full border px-4 py-1 text-xs font-medium transition-colors",
    active
      ? "border-brand-500 bg-brand-50 text-brand-700"
      : "border-slate-200 bg-white text-slate-400 hover:border-slate-300",
  );

/** Yes/No toggle sitting right next to its question (tri-state until answered). */
function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-50 py-2 last:border-0">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="flex gap-1.5">
        {[
          { label: "Yes", v: true },
          { label: "No", v: false },
        ].map((opt) => (
          <button
            key={opt.label}
            type="button"
            onClick={() => onChange(opt.v)}
            className={pillClass(value === opt.v)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Single-select quick-pick row. Clicking the active pill again clears it. */
function PillSelect({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(value === opt ? "" : opt)}
          className={pillClass(value === opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/** Multi-select quick-pick row (a patient may pick several). */
function PillMulti({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onToggle(opt)}
          className={pillClass(selected.includes(opt))}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/** Splits a comma-joined string field into trimmed, non-empty tokens. */
const splitList = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function CheckItem({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500/30"
      />
      {label}
    </label>
  );
}

// ---------- View-mode display ----------

const fmtYes = (v: boolean | null, detail?: string) =>
  v === true ? (detail ? `Yes — ${detail}` : "Yes") : v === false ? "No" : "Not answered";

function ViewItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-slate-50 py-2.5 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="font-normal text-slate-400">None reported</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span
          key={i}
          className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700"
        >
          {i}
        </span>
      ))}
    </span>
  );
}

export function MedicalHistoryTab({ clientId }: { clientId: string }) {
  const { data, loading, error, refetch } = useApi(
    () => api.getMedicalHistory(clientId),
    [clientId],
  );
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate when the fetch resolves: existing record → read-only view; no record
  // yet → start in edit mode with an empty form.
  useEffect(() => {
    if (loading) return;
    if (data) {
      setForm(fromRecord(data));
      setEditing(false);
    } else {
      setForm(EMPTY);
      setEditing(true);
    }
  }, [data, loading]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: "conditions" | "familyHistory", value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value)
        ? f[key].filter((v) => v !== value)
        : [...f[key], value],
    }));

  // Exercise type is stored as one comma-joined string but edited as multi-select
  // pills plus an "Other" free-text — split it into known presets vs. the rest.
  const exerciseTokens = splitList(form.exerciseType);
  const exercisePresets = exerciseTokens.filter((t) =>
    (EXERCISE_TYPES as readonly string[]).includes(t),
  );
  const exerciseOther = exerciseTokens
    .filter((t) => !(EXERCISE_TYPES as readonly string[]).includes(t))
    .join(", ");
  const joinExercise = (presets: string[], other: string) =>
    [...presets, ...(other.trim() ? [other] : [])].join(", ");
  const toggleExercise = (opt: string) => {
    const next = exercisePresets.includes(opt)
      ? exercisePresets.filter((p) => p !== opt)
      : [...exercisePresets, opt];
    set({ exerciseType: joinExercise(next, exerciseOther) });
  };

  async function save() {
    setSaving(true);
    try {
      const saved = await api.saveMedicalHistory(clientId, toPayload(form));
      setForm(fromRecord(saved));
      setEditing(false);
      toast("Medical history saved");
      refetch();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (data) {
      setForm(fromRecord(data));
      setEditing(false);
    }
  }

  const actions = editing ? (
    <div className="flex gap-2">
      {data && (
        <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
      )}
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
      <Pencil className="h-4 w-4" /> Edit
    </Button>
  );

  const exerciseSummary =
    form.exercises === true
      ? ["Yes", [form.exerciseType, form.exerciseFrequency].filter(Boolean).join(", ")]
          .filter(Boolean)
          .join(" — ")
      : fmtYes(form.exercises);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {data
            ? `Last updated ${data.updatedAt ? formatDate(data.updatedAt) : ""}`
            : "No medical history recorded yet — complete the form below."}
        </p>
        {actions}
      </div>

      {/* 1. Medical history */}
      <Card>
        <CardHeader
          title="Medical history"
          subtitle="Conditions the patient has or had."
        />
        <CardBody>
          {editing ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-500">
                Please check if the patient has or had any of the following:
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {MEDICAL_CONDITIONS.map((c) => (
                  <CheckItem
                    key={c}
                    label={c}
                    checked={form.conditions.includes(c)}
                    onChange={() => toggle("conditions", c)}
                  />
                ))}
              </div>
              {form.conditions.includes("Intolerance diagnosed by a doctor") && (
                <FormRow label="Intolerance — please specify">
                  <Input
                    value={form.intoleranceDetail}
                    onChange={(e) => set({ intoleranceDetail: e.target.value })}
                  />
                </FormRow>
              )}
              {form.conditions.includes("Other") && (
                <FormRow label="Other — please specify">
                  <Input
                    value={form.conditionsOther}
                    onChange={(e) => set({ conditionsOther: e.target.value })}
                  />
                </FormRow>
              )}
            </div>
          ) : (
            <div>
              <ViewItem label="Reported conditions" value={<Chips items={form.conditions} />} />
              {form.conditions.includes("Intolerance diagnosed by a doctor") && form.intoleranceDetail && (
                <ViewItem label="Intolerance details" value={form.intoleranceDetail} />
              )}
              {form.conditions.includes("Other") && form.conditionsOther && (
                <ViewItem label="Other details" value={form.conditionsOther} />
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 2. Allergies */}
      <Card>
        <CardHeader title="Allergies" />
        <CardBody>
          {editing ? (
            <div className="space-y-3">
              <YesNo
                label="Does the patient have any known food or drug allergies?"
                value={form.hasAllergies}
                onChange={(v) => set({ hasAllergies: v })}
              />
              {form.hasAllergies === true && (
                <FormRow label="If yes, please list">
                  <Textarea
                    rows={2}
                    value={form.allergiesDetail}
                    onChange={(e) => set({ allergiesDetail: e.target.value })}
                  />
                </FormRow>
              )}
            </div>
          ) : (
            <ViewItem
              label="Known food or drug allergies"
              value={fmtYes(form.hasAllergies, form.allergiesDetail)}
            />
          )}
        </CardBody>
      </Card>

      {/* 3. Medications & supplements */}
      <Card>
        <CardHeader title="Medications & supplements" />
        <CardBody>
          {editing ? (
            <div className="space-y-3">
              <YesNo
                label="Is the patient currently taking any medications or commercial weight-loss pills?"
                value={form.takingMedications}
                onChange={(v) => set({ takingMedications: v })}
              />
              {form.takingMedications === true && (
                <FormRow label="Please list all with dosage and frequency">
                  <Textarea
                    rows={2}
                    value={form.medicationsDetail}
                    onChange={(e) => set({ medicationsDetail: e.target.value })}
                  />
                </FormRow>
              )}
              <YesNo
                label="Is the patient taking any supplements, vitamins, or herbal products?"
                value={form.takingSupplements}
                onChange={(v) => set({ takingSupplements: v })}
              />
              {form.takingSupplements === true && (
                <FormRow label="Please list">
                  <Textarea
                    rows={2}
                    value={form.supplementsDetail}
                    onChange={(e) => set({ supplementsDetail: e.target.value })}
                  />
                </FormRow>
              )}
              <YesNo
                label="Has the patient ever had any surgeries?"
                value={form.hadSurgeries}
                onChange={(v) => set({ hadSurgeries: v })}
              />
              {form.hadSurgeries === true && (
                <FormRow label="Please specify type and date">
                  <Textarea
                    rows={2}
                    value={form.surgeriesDetail}
                    onChange={(e) => set({ surgeriesDetail: e.target.value })}
                  />
                </FormRow>
              )}
            </div>
          ) : (
            <div>
              <ViewItem
                label="Medications / weight-loss pills"
                value={fmtYes(form.takingMedications, form.medicationsDetail)}
              />
              <ViewItem
                label="Supplements / vitamins / herbal"
                value={fmtYes(form.takingSupplements, form.supplementsDetail)}
              />
              <ViewItem
                label="Previous surgeries"
                value={fmtYes(form.hadSurgeries, form.surgeriesDetail)}
              />
            </div>
          )}
        </CardBody>
      </Card>

      {/* 4. Family medical history */}
      <Card>
        <CardHeader
          title="Family medical history"
          subtitle="Conditions among immediate family members."
        />
        <CardBody>
          {editing ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-500">
                Check if any immediate family members have had the following:
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {FAMILY_CONDITIONS.map((c) => (
                  <CheckItem
                    key={c}
                    label={c}
                    checked={form.familyHistory.includes(c)}
                    onChange={() => toggle("familyHistory", c)}
                  />
                ))}
              </div>
              {form.familyHistory.includes("Cancer") && (
                <FormRow label="Cancer — please specify type">
                  <Input
                    value={form.familyCancerDetail}
                    onChange={(e) => set({ familyCancerDetail: e.target.value })}
                  />
                </FormRow>
              )}
              {form.familyHistory.includes("Other") && (
                <FormRow label="Other — please specify">
                  <Input
                    value={form.familyOther}
                    onChange={(e) => set({ familyOther: e.target.value })}
                  />
                </FormRow>
              )}
            </div>
          ) : (
            <div>
              <ViewItem label="Family conditions" value={<Chips items={form.familyHistory} />} />
              {form.familyHistory.includes("Cancer") && form.familyCancerDetail && (
                <ViewItem label="Cancer type" value={form.familyCancerDetail} />
              )}
              {form.familyHistory.includes("Other") && form.familyOther && (
                <ViewItem label="Other details" value={form.familyOther} />
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 5. Lifestyle */}
      <Card>
        <CardHeader title="Lifestyle" />
        <CardBody>
          {editing ? (
            <div className="space-y-3">
              <YesNo
                label="Does the patient drink enough water daily?"
                value={form.drinksWater}
                onChange={(v) => set({ drinksWater: v })}
              />
              <FormRow label="How many glasses?">
                <PillSelect
                  options={WATER_GLASSES}
                  value={form.waterGlasses}
                  onChange={(v) => set({ waterGlasses: v })}
                />
              </FormRow>
              <YesNo
                label="Does the patient drink coffee, tea, or energy drinks?"
                value={form.drinksCaffeine}
                onChange={(v) => set({ drinksCaffeine: v })}
              />
              <YesNo
                label="Does the patient drink alcohol?"
                value={form.drinksAlcohol}
                onChange={(v) => set({ drinksAlcohol: v })}
              />
              {form.drinksAlcohol === true && (
                <FormRow label="If yes, how often?">
                  <PillSelect
                    options={ALCOHOL_FREQUENCY}
                    value={form.alcoholFrequency}
                    onChange={(v) => set({ alcoholFrequency: v })}
                  />
                </FormRow>
              )}
              <YesNo
                label="Does the patient smoke?"
                value={form.smokes}
                onChange={(v) => set({ smokes: v })}
              />
              {form.smokes === true && (
                <FormRow label="How many per day?">
                  <PillSelect
                    options={CIGARETTES_PER_DAY}
                    value={form.cigarettesPerDay}
                    onChange={(v) => set({ cigarettesPerDay: v })}
                  />
                </FormRow>
              )}
              <YesNo
                label="Does the patient exercise regularly?"
                value={form.exercises}
                onChange={(v) => set({ exercises: v })}
              />
              {form.exercises === true && (
                <div className="space-y-3">
                  <FormRow label="Type of activity">
                    <div className="space-y-2">
                      <PillMulti
                        options={EXERCISE_TYPES}
                        selected={exercisePresets}
                        onToggle={toggleExercise}
                      />
                      <Input
                        value={exerciseOther}
                        onChange={(e) =>
                          set({ exerciseType: joinExercise(exercisePresets, e.target.value) })
                        }
                        placeholder="Other activity (optional)"
                      />
                    </div>
                  </FormRow>
                  <FormRow label="Frequency per week">
                    <PillSelect
                      options={EXERCISE_FREQUENCY}
                      value={form.exerciseFrequency}
                      onChange={(v) => set({ exerciseFrequency: v })}
                    />
                  </FormRow>
                </div>
              )}
              <FormRow label="Hours of sleep per night">
                <PillSelect
                  options={SLEEP_HOURS}
                  value={form.sleepHours}
                  onChange={(v) => set({ sleepHours: v })}
                />
              </FormRow>
              <YesNo
                label="Does the patient wake up rested?"
                value={form.wakesRested}
                onChange={(v) => set({ wakesRested: v })}
              />
              <YesNo
                label="Does the patient feel stressed often?"
                value={form.feelsStressed}
                onChange={(v) => set({ feelsStressed: v })}
              />
              <YesNo
                label="Does the patient follow a specific diet?"
                value={form.followsDiet}
                onChange={(v) => set({ followsDiet: v })}
              />
              <YesNo
                label="Does the patient snack frequently?"
                value={form.snacksFrequently}
                onChange={(v) => set({ snacksFrequently: v })}
              />
              <YesNo
                label="Does the patient often feel fatigued?"
                value={form.feelsFatigued}
                onChange={(v) => set({ feelsFatigued: v })}
              />
              <YesNo
                label="Does the patient experience mood swings?"
                value={form.moodSwings}
                onChange={(v) => set({ moodSwings: v })}
              />
            </div>
          ) : (
            <div>
              <ViewItem label="Drinks enough water daily" value={fmtYes(form.drinksWater)} />
              <ViewItem label="Glasses per day" value={form.waterGlasses || "—"} />
              <ViewItem label="Coffee / tea / energy drinks" value={fmtYes(form.drinksCaffeine)} />
              <ViewItem label="Drinks alcohol" value={fmtYes(form.drinksAlcohol, form.alcoholFrequency)} />
              <ViewItem label="Smokes" value={fmtYes(form.smokes, form.cigarettesPerDay)} />
              <ViewItem label="Exercises regularly" value={exerciseSummary} />
              <ViewItem label="Hours of sleep per night" value={form.sleepHours || "—"} />
              <ViewItem label="Wakes up rested" value={fmtYes(form.wakesRested)} />
              <ViewItem label="Feels stressed often" value={fmtYes(form.feelsStressed)} />
              <ViewItem label="Follows a specific diet" value={fmtYes(form.followsDiet)} />
              <ViewItem label="Snacks frequently" value={fmtYes(form.snacksFrequently)} />
              <ViewItem label="Often feels fatigued" value={fmtYes(form.feelsFatigued)} />
              <ViewItem label="Experiences mood swings" value={fmtYes(form.moodSwings)} />
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex justify-end">{actions}</div>
    </div>
  );
}
