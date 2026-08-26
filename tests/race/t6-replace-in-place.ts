/**
 * Regression guard for the delete-then-create -> upsert change: regenerating a
 * Food List PDF must still REPLACE the visit's sheet (one row, fresh bytes,
 * fresh timestamp, "Regenerated" in the audit log) rather than stack copies.
 */
import { db } from "../../src/server/db";
import { generateFoodListPdf, ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);

  const first = await generateFoodListPdf(c.id, ACTOR);
  const firstRow = await db.consultationFile.findUniqueOrThrow({ where: { id: first.id } });

  // The doctor ticks more boxes, then regenerates.
  await db.consultationFoodList.update({
    where: { consultationId: c.id },
    data: {
      selections: JSON.stringify([
        "vegetables.artichoke",
        "fruits.apple",
        "eggs-and-dairy.cows-milk",
        "nuts-and-seeds.almonds",
      ]),
    },
  });
  const second = await generateFoodListPdf(c.id, ACTOR);
  const rows = await db.consultationFile.findMany({ where: { consultationId: c.id } });
  const secondRow = rows[0];

  ok("still exactly one file after regenerating", rows.length === 1, `${rows.length}`);
  ok("the row is replaced in place", second.id === first.id);
  ok("bytes were actually refreshed", !Buffer.from(secondRow.data).equals(Buffer.from(firstRow.data)));
  ok(
    "createdAt moves forward (the staleness signal)",
    secondRow.createdAt > firstRow.createdAt,
    `${firstRow.createdAt.toISOString()} -> ${secondRow.createdAt.toISOString()}`,
  );
  ok("filename/size stay consistent with the new render", second.size === secondRow.data.length);

  const audits = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  ok(
    "audit log distinguishes generate from regenerate",
    audits.length === 2 &&
      audits[0].action === "Generated Food List PDF" &&
      audits[1].action === "Regenerated Food List PDF",
    audits.map((a) => a.action).join(" | "),
  );

  // Auto-generate-on-close fallback still no-ops on an up-to-date sheet...
  ok("close catch-up no-ops when nothing changed", (await ensureFoodListPdf(c.id, ACTOR)) === null);

  // ...and still no-ops when the form exists but nothing is ticked.
  const c2 = await makeConsultationWithFoodList(client.id, doctor.id);
  await db.consultationFoodList.update({
    where: { consultationId: c2.id },
    data: { selections: "[]" },
  });
  ok("close catch-up no-ops on an empty form", (await ensureFoodListPdf(c2.id, ACTOR)) === null);
  ok(
    "no file attached for the empty form",
    (await db.consultationFile.count({ where: { consultationId: c2.id } })) === 0,
  );
}

main().finally(() => db.$disconnect());
