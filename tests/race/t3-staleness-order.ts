/**
 * #3 — the staleness check in ensureFoodListPdf must judge against the MOST
 * RECENT Food List PDF, not whichever row the database hands back first.
 *
 * Scenario: an old PDF (T1), the form edited (T2), a fresh PDF (T3). Nothing is
 * stale, so closing the visit must NOT re-render. Picking the arbitrary/oldest
 * row instead makes it wrongly decide the sheet is out of date.
 *
 * Once the (consultationId, kind) unique constraint exists the app can no longer
 * produce two rows — so this test drops the index for the duration to recreate
 * the multi-file world the ordering guards against, then puts it back.
 */
import { db } from "../../src/server/db";
import { ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

const INDEX = "ConsultationFile_consultationId_kind_key";

async function hasUniqueIndex() {
  const rows = await db.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE indexname = '${INDEX}'`,
  );
  return rows.length > 0;
}

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);

  const indexed = await hasUniqueIndex();
  if (indexed) await db.$executeRawUnsafe(`DROP INDEX "${INDEX}"`);
  try {
    const t = (min: number) => new Date(Date.now() - min * 60_000);
    // Oldest row inserted FIRST so an unordered query tends to return it first.
    await db.consultationFile.create({
      data: {
        consultationId: c.id,
        kind: "food-list",
        filename: "old.pdf",
        mimeType: "application/pdf",
        size: 1,
        data: new Uint8Array([1]),
        uploadedByName: ACTOR.name,
        createdAt: t(30), // T1: before the form edit
      },
    });
    await db.consultationFoodList.update({
      where: { consultationId: c.id },
      data: { updatedAt: t(20) }, // T2: doctor ticked more boxes
    });
    await db.consultationFile.create({
      data: {
        consultationId: c.id,
        kind: "food-list",
        filename: "fresh.pdf",
        mimeType: "application/pdf",
        size: 1,
        data: new Uint8Array([1]),
        uploadedByName: ACTOR.name,
        createdAt: t(10), // T3: regenerated after the edit — nothing is stale
      },
    });

    const result = await ensureFoodListPdf(c.id, ACTOR);
    ok(
      "up-to-date visit with an older PDF alongside is left alone",
      result === null,
      result ? "re-rendered against the OLD file" : "no re-render",
    );

  } finally {
    // Restore the invariant: keep the newest row, then re-create the index.
    if (indexed) {
      const rows = await db.consultationFile.findMany({
        where: { consultationId: c.id, kind: "food-list" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      for (const r of rows.slice(1)) await db.consultationFile.delete({ where: { id: r.id } });
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "${INDEX}" ON "ConsultationFile"("consultationId", "kind")`,
      );
    }
  }

  // ...and the inverse, back in the one-file world the constraint enforces: the
  // current sheet is older than the form, so closing must re-render it.
  await db.consultationFoodList.update({
    where: { consultationId: c.id },
    data: { updatedAt: new Date() },
  });
  const regenerated = await ensureFoodListPdf(c.id, ACTOR);
  ok("genuinely stale sheet is regenerated", regenerated !== null);
  const total = await db.consultationFile.count({ where: { consultationId: c.id } });
  ok("regenerating still leaves exactly one file", total === 1, `found ${total}`);
}

main().finally(() => db.$disconnect());
