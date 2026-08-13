"use client";

import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import {
  FOOD_LIST_CATEGORIES,
  categoryTitle,
  itemLabel,
} from "@/lib/food-list";
import type { Consultation } from "@/lib/types";
import { bmiCategory, formatDate } from "@/lib/utils";

/**
 * The read-only Visit Summary for a **closed** consultation.
 *
 * A closed visit is a finalized historical record — the consultation editor
 * refuses to open one (see `consultations/new/page.tsx`), so this is where the
 * doctor reads back what actually happened at that appointment.
 *
 * Everything rendered here comes from the visit's own frozen columns on the
 * `Consultation` row (weight, measurements, the clinical text, the food list),
 * never from the client's current record. That is the whole point: a
 * patient who weighed 60 kg at Visit #1 and 56 kg today still reads 60 kg here.
 * Do not "enrich" this view with live client data.
 *
 * Deliberately not offered for an in-progress visit: a draft is still being
 * edited, and its record isn't final until close. The card's "Continue" button
 * remains the only action there.
 *
 * **This is a clinical view and carries no money.** No prices, fees, discounts,
 * totals, payments or debt appear here, for any role — the question it answers is
 * "what was prescribed, requested, performed or given", not "what did it cost".
 * The financial history of a visit lives in the Payments tab and the settlement
 * flow. Don't reintroduce a price line here because the data happens to be on the
 * `Consultation` object.
 */
export function VisitSummaryModal({
  consultation,
  onClose,
}: {
  consultation: Consultation | null;
  onClose: () => void;
}) {
  if (!consultation) return null;
  const c = consultation;

  const treatments = c.treatments ?? [];
  const products = c.products ?? [];

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={`Visit #${c.visitNumber} summary · ${formatDate(c.date)}`}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <Badge tone="gray">Closed</Badge>
          <span>{c.dietitianName}</span>
          <span className="text-slate-300">·</span>
          <span className="text-xs">Recorded as of this visit — not current values</span>
        </div>

        <Section title="Measurements">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <Stat label="Weight" value={c.weightKg ? `${c.weightKg} kg` : undefined} />
            <Stat label="Height" value={c.heightCm ? `${c.heightCm} cm` : undefined} />
            <Stat label="BMI" value={c.bmi ? `${c.bmi} · ${bmiCategory(c.bmi)}` : undefined} />
            <Stat label="Goal weight" value={c.goalWeightKg ? `${c.goalWeightKg} kg` : undefined} />
            <Stat label="Waist" value={c.waistCm ? `${c.waistCm} cm` : undefined} />
            <Stat label="Hips" value={c.hipsCm ? `${c.hipsCm} cm` : undefined} />
            <Stat label="Body fat" value={c.bodyFatPercent ? `${c.bodyFatPercent}%` : undefined} />
            <Stat label="Muscle mass" value={c.muscleMassKg ? `${c.muscleMassKg} kg` : undefined} />
          </dl>
        </Section>

        {(c.clientGoals || c.notes || c.recommendations || c.followUpPlan) && (
          <Section title="Clinical record">
            <div className="space-y-2 text-sm text-slate-600">
              <Text label="Patient goals" value={c.clientGoals} />
              <Text label="Notes" value={c.notes} />
              <Text label="Recommendations" value={c.recommendations} />
              <Text label="Follow-up plan" value={c.followUpPlan} />
            </div>
          </Section>
        )}

        {c.foodList && <FoodListSummary foodList={c.foodList} />}

        {(c.bloodCollection || c.nurseRequired) && (
          <Section title="Blood tests & nurse">
            <div className="space-y-1 text-sm text-slate-600">
              {c.bloodCollection && (
                <p>
                  <span className="font-medium text-slate-700">Blood tests: </span>
                  {/* Names only. `bloodTestCharges` also carries the frozen price of
                      each test; it is read here purely because it is the more
                      complete record of which tests were ordered. */}
                  {c.bloodTestCharges && c.bloodTestCharges.length > 0
                    ? c.bloodTestCharges.map((t) => t.name).join(", ")
                    : c.bloodTests && c.bloodTests.length > 0
                      ? c.bloodTests.join(", ")
                      : "Requested"}
                </p>
              )}
              {c.nurseRequired && (
                <p><span className="font-medium text-slate-700">Nurse: </span>Required</p>
              )}
            </div>
          </Section>
        )}

        {treatments.length > 0 && (
          <Section title="Treatments">
            <ul className="space-y-2 text-sm text-slate-600">
              {treatments.map((t, i) => (
                <li key={t.id ?? i} className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="font-medium text-slate-700">{t.machineOther || t.machine}</p>
                  <p className="text-xs text-slate-500">
                    {t.bodyParts.length > 0 ? t.bodyParts.join(", ") : "No body parts recorded"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t.sessionsUsed} of {t.sessionsNeeded} session
                    {t.sessionsNeeded !== 1 ? "s" : ""} used this visit
                    {t.packageName
                      ? ` · bundle: ${t.packageName}`
                      : t.sessionPlanId
                        ? " · session plan"
                        : ""}
                  </p>
                  {t.notes && <p className="mt-1 text-xs text-slate-500">{t.notes}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {products.length > 0 && (
          <Section title="Products">
            <ul className="space-y-1 text-sm text-slate-600">
              {products.map((p, i) => (
                <li key={p.id ?? i}>
                  <span className="font-medium text-slate-700">{p.name}</span> ×{p.quantity}
                  {p.notes && <span className="text-slate-400"> — {p.notes}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}

      </div>
    </Modal>
  );
}

/** The food list exactly as ticked on this visit, grouped by printed category. */
function FoodListSummary({ foodList }: { foodList: NonNullable<Consultation["foodList"]> }) {
  const selected = new Set(foodList.selections);
  const groups = FOOD_LIST_CATEGORIES.map((cat) => ({
    title: categoryTitle(cat, foodList.language),
    items: cat.items.filter((i) => selected.has(i.id)).map((i) => itemLabel(i, foodList.language)),
  })).filter((g) => g.items.length > 0);

  return (
    <Section title={`Food list (${foodList.language === "ar" ? "Arabic" : "English"})`}>
      {groups.length === 0 ? (
        <p className="text-sm text-slate-400">Form saved with nothing ticked.</p>
      ) : (
        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g.title}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {g.title}
              </p>
              <p className="text-slate-600">{g.items.join(", ")}</p>
            </div>
          ))}
        </div>
      )}
      {foodList.notes && (
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Notes: </span>
          {foodList.notes}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">
        The printable PDF of this form is on the Files tab.
      </p>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-700">{value ?? "—"}</dd>
    </div>
  );
}

function Text({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <p className="whitespace-pre-wrap">
      <span className="font-medium text-slate-700">{label}: </span>
      {value}
    </p>
  );
}
