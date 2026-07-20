import type { MedicalHistory as PMedicalHistory } from "@prisma/client";
import { db } from "../db";
import type { MedicalHistory } from "@/lib/types";
import type { MedicalHistoryInput } from "@/lib/validation";

/** Tolerant parse of a JSON-encoded string[] column. */
function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toMedicalHistory(m: PMedicalHistory): MedicalHistory {
  return {
    conditions: parseList(m.conditions),
    intoleranceDetail: m.intoleranceDetail ?? undefined,
    conditionsOther: m.conditionsOther ?? undefined,

    hasAllergies: m.hasAllergies,
    allergiesDetail: m.allergiesDetail ?? undefined,

    takingMedications: m.takingMedications,
    medicationsDetail: m.medicationsDetail ?? undefined,
    takingSupplements: m.takingSupplements,
    supplementsDetail: m.supplementsDetail ?? undefined,
    hadSurgeries: m.hadSurgeries,
    surgeriesDetail: m.surgeriesDetail ?? undefined,

    familyHistory: parseList(m.familyHistory),
    familyCancerDetail: m.familyCancerDetail ?? undefined,
    familyOther: m.familyOther ?? undefined,

    drinksWater: m.drinksWater,
    waterGlasses: m.waterGlasses ?? undefined,
    drinksCaffeine: m.drinksCaffeine,
    drinksAlcohol: m.drinksAlcohol,
    alcoholFrequency: m.alcoholFrequency ?? undefined,
    smokes: m.smokes,
    cigarettesPerDay: m.cigarettesPerDay ?? undefined,
    exercises: m.exercises,
    exerciseType: m.exerciseType ?? undefined,
    exerciseFrequency: m.exerciseFrequency ?? undefined,
    sleepHours: m.sleepHours ?? undefined,
    wakesRested: m.wakesRested,
    feelsStressed: m.feelsStressed,
    followsDiet: m.followsDiet,
    snacksFrequently: m.snacksFrequently,
    feelsFatigued: m.feelsFatigued,
    moodSwings: m.moodSwings,

    updatedAt: m.updatedAt.toISOString(),
  };
}

export async function getMedicalHistory(
  clientId: string,
): Promise<MedicalHistory | null> {
  const row = await db.medicalHistory.findUnique({ where: { clientId } });
  return row ? toMedicalHistory(row) : null;
}

/** Creates the record on first save, then edits it in place — never duplicated. */
export async function upsertMedicalHistory(
  clientId: string,
  input: MedicalHistoryInput,
): Promise<MedicalHistory> {
  const nb = (v: boolean | null | undefined) => v ?? null;
  const ns = (v: string | null | undefined) => (v ? v : null);

  const data = {
    conditions: JSON.stringify(input.conditions ?? []),
    intoleranceDetail: ns(input.intoleranceDetail),
    conditionsOther: ns(input.conditionsOther),

    hasAllergies: nb(input.hasAllergies),
    allergiesDetail: ns(input.allergiesDetail),

    takingMedications: nb(input.takingMedications),
    medicationsDetail: ns(input.medicationsDetail),
    takingSupplements: nb(input.takingSupplements),
    supplementsDetail: ns(input.supplementsDetail),
    hadSurgeries: nb(input.hadSurgeries),
    surgeriesDetail: ns(input.surgeriesDetail),

    familyHistory: JSON.stringify(input.familyHistory ?? []),
    familyCancerDetail: ns(input.familyCancerDetail),
    familyOther: ns(input.familyOther),

    drinksWater: nb(input.drinksWater),
    waterGlasses: ns(input.waterGlasses),
    drinksCaffeine: nb(input.drinksCaffeine),
    drinksAlcohol: nb(input.drinksAlcohol),
    alcoholFrequency: ns(input.alcoholFrequency),
    smokes: nb(input.smokes),
    cigarettesPerDay: ns(input.cigarettesPerDay),
    exercises: nb(input.exercises),
    exerciseType: ns(input.exerciseType),
    exerciseFrequency: ns(input.exerciseFrequency),
    sleepHours: ns(input.sleepHours),
    wakesRested: nb(input.wakesRested),
    feelsStressed: nb(input.feelsStressed),
    followsDiet: nb(input.followsDiet),
    snacksFrequently: nb(input.snacksFrequently),
    feelsFatigued: nb(input.feelsFatigued),
    moodSwings: nb(input.moodSwings),
  };

  const row = await db.medicalHistory.upsert({
    where: { clientId },
    create: { clientId, ...data },
    update: data,
  });
  return toMedicalHistory(row);
}
