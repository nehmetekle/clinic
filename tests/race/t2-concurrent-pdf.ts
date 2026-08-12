/**
 * #2 — two "generate PDF" calls landing at the same moment on one visit
 * (manual Generate racing the auto-generate-on-close), which is exactly what
 * the gap in #1 makes reachable.
 *
 * Expected after the fix: exactly ONE ConsultationFile row survives, and no
 * caller sees a raw Prisma error (P2002 / "Unique constraint failed").
 */
import { db } from "../../src/server/db";
import { generateFoodListPdf } from "../../src/server/services/foodListPdf";
import { ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { renderFoodListPdf } from "../../src/server/pdf/food-list-pdf";
import { saveConsultationFile } from "../../src/server/repositories/consultationFiles";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();

  // --- (a) two manual generates fired together (double-click) ---
  const c1 = await makeConsultationWithFoodList(client.id, doctor.id);
  const results = await Promise.allSettled([
    generateFoodListPdf(c1.id, ACTOR),
    generateFoodListPdf(c1.id, ACTOR),
  ]);
  const files1 = await db.consultationFile.count({
    where: { consultationId: c1.id, kind: "food-list" },
  });
  const raw = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason));
  const rawLeak = raw.filter((m) => /P2002|Unique constraint|prisma/i.test(m));
  ok("double-click Generate leaves exactly 1 file", files1 === 1, `found ${files1}`);
  ok("no raw DB error surfaced", rawLeak.length === 0, rawLeak.join(" | ") || "none");
  if (raw.length) console.log(`  ..    rejections seen: ${raw.join(" | ")}`);

  // --- (b) manual generate racing the auto-generate-on-close catch-up ---
  const c2 = await makeConsultationWithFoodList(client.id, doctor.id);
  const results2 = await Promise.allSettled([
    generateFoodListPdf(c2.id, ACTOR),
    ensureFoodListPdf(c2.id, ACTOR),
  ]);
  const files2 = await db.consultationFile.count({
    where: { consultationId: c2.id, kind: "food-list" },
  });
  const raw2 = results2
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason));
  ok("manual generate vs auto-on-close leaves exactly 1 file", files2 === 1, `found ${files2}`);
  ok("close path never rejects", raw2.length === 0, raw2.join(" | ") || "none");

  // --- (c) the tightest race: two stores landing together, rendering already done ---
  const c3 = await makeConsultationWithFoodList(client.id, doctor.id);
  const data = Buffer.from(await renderFoodListPdf({
    language: "en",
    patientName: "Race Patient",
    selections: ["fruits.apple"],
  }));
  const store = (n: number) =>
    saveConsultationFile(
      {
        consultationId: c3.id,
        kind: "food-list",
        filename: `Food List ${n}.pdf`,
        mimeType: "application/pdf",
        data,
      },
      ACTOR,
    );
  const results3 = await Promise.allSettled([store(1), store(2), store(3)]);
  const files3 = await db.consultationFile.count({ where: { consultationId: c3.id } });
  const raw3 = results3
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason));
  ok("3 simultaneous stores leave exactly 1 file", files3 === 1, `found ${files3}`);
  ok(
    "no raw DB error from simultaneous stores",
    raw3.every((m) => !/P2002|Unique constraint|prisma/i.test(m)),
    raw3.join(" | ") || "none",
  );

  // The surviving file must be a real, downloadable PDF (not a truncated row).
  const survivor = await db.consultationFile.findFirst({ where: { consultationId: c2.id } });
  const bytes = survivor ? Buffer.from(survivor.data) : Buffer.alloc(0);
  ok(
    "surviving file is a valid PDF",
    bytes.length > 1000 && bytes.subarray(0, 5).toString() === "%PDF-",
    `${bytes.length} bytes`,
  );
}

main().finally(() => db.$disconnect());
