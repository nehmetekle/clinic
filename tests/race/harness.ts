/**
 * Shared fixtures for the Food List PDF race tests. Runs against a throwaway
 * `nutriclinic_test` database (never the dev DB) — see run.sh.
 */
import { db } from "../../src/server/db";

export const ACTOR = { name: "Dr Test", email: "doctor@test.local" };

export async function resetDb() {
  // Order matters only for tables without cascade from Client/User.
  await db.auditLog.deleteMany({});
  await db.consultationFile.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
}

export async function makeDoctor() {
  return db.user.create({
    data: {
      fullName: ACTOR.name,
      email: ACTOR.email,
      role: "dietitian",
      passwordHash: "x",
    },
  });
}

export async function makeClient() {
  return db.client.create({
    data: { firstName: "Race", lastName: "Patient", phone: "+96170123456" },
  });
}

/** A saved open visit with a filled-in Food List (3 ticks). */
export async function makeConsultationWithFoodList(clientId: string, dietitianId: string) {
  const c = await db.consultation.create({
    data: { clientId, dietitianId, date: new Date(), visitNumber: 1, status: "open" },
  });
  await db.consultationFoodList.create({
    data: {
      consultationId: c.id,
      language: "en",
      patientName: "Race Patient",
      selections: JSON.stringify(["vegetables.artichoke", "fruits.apple", "eggs-and-dairy.cows-milk"]),
    },
  });
  return c;
}

export function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

export function info(label: string) {
  console.log(`  ..    ${label}`);
}
