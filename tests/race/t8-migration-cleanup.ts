/**
 * The dedupe step of migration 20260812140000 must keep the NEWEST file per
 * (consultation, kind) and leave nothing behind. PDF bytes live in the row
 * itself (`data Bytes`), so deleting a row is the whole story — there is no file
 * on disk to orphan — and this checks the bytes really do go with it.
 *
 * "Nothing left behind" is asserted by EXACT byte accounting: the total
 * `octet_length(data)` held by the table must equal precisely the surviving rows'
 * payloads. That is a deterministic property of the data.
 *
 * It deliberately does NOT measure `pg_total_relation_size` before/after a
 * VACUUM, which is what this test used to do. That assertion was nondeterministic
 * for two compounding reasons: relation size includes fixed page/TOAST overhead
 * that dominates at this scale, and the old fixture payload was 300KB of a single
 * repeated byte, which TOAST compresses to almost nothing — so the "did it shrink
 * by half" ratio was measuring storage-engine overhead and autovacuum timing
 * rather than the migration. The payload below is pseudo-random (and therefore
 * genuinely incompressible) so the byte accounting reflects real stored data.
 */
import { db } from "../../src/server/db";
import { makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

const INDEX = "ConsultationFile_consultationId_kind_key";
const DEDUPE = `
DELETE FROM "ConsultationFile" a
USING "ConsultationFile" b
WHERE a."consultationId" = b."consultationId"
  AND a."kind" = b."kind"
  AND (a."createdAt", a."id") < (b."createdAt", b."id");`;

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);

  await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`);
  // Large enough to be TOASTed, and incompressible so the stored bytes actually
  // are the payload. Seeded LCG rather than Math.random: the fixture must be
  // identical on every run for the byte totals below to be exact.
  const big = new Uint8Array(300_000);
  let seed = 0x2545f491;
  for (let i = 0; i < big.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    big[i] = seed & 0xff;
  }
  const t = (d: number) => new Date(Date.now() - d * 86_400_000);
  for (const [id, name, day] of [["f1", "oldest.pdf", 3], ["f2", "middle.pdf", 2], ["f3", "newest.pdf", 1]] as const) {
    await db.consultationFile.create({
      data: {
        id,
        consultationId: c.id,
        kind: "food-list",
        filename: name,
        mimeType: "application/pdf",
        size: big.length,
        data: big,
        uploadedByName: "X",
        createdAt: t(day),
      },
    });
  }
  // A different kind on the same visit must survive untouched.
  await db.consultationFile.create({
    data: {
      id: "other",
      consultationId: c.id,
      kind: "other-doc",
      filename: "keep.pdf",
      mimeType: "application/pdf",
      size: 3,
      data: new Uint8Array([1, 2, 3]),
      uploadedByName: "X",
    },
  });


  await db.$executeRawUnsafe(DEDUPE);
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX "${INDEX}" ON "ConsultationFile"("consultationId", "kind")`,
  );

  const survivors = await db.consultationFile.findMany({
    where: { consultationId: c.id },
    select: { id: true, filename: true, kind: true },
    orderBy: { kind: "asc" },
  });
  ok("one food-list file survives", survivors.filter((f) => f.kind === "food-list").length === 1);
  ok(
    "and it is the NEWEST one",
    survivors.find((f) => f.kind === "food-list")?.id === "f3",
    survivors.map((f) => `${f.kind}:${f.filename}`).join(", "),
  );
  ok("a different kind on the same visit is untouched", survivors.some((f) => f.id === "other"));
  const [{ dangling }] = await db.$queryRawUnsafe<{ dangling: bigint }[]>(
    `SELECT count(*) AS dangling FROM "ConsultationFile" f
     LEFT JOIN "Consultation" c ON c.id = f."consultationId" WHERE c.id IS NULL`,
  );
  ok("no rows left pointing at a missing consultation", Number(dangling) === 0);

  // The keeper's payload must survive the dedupe byte-for-byte — proving the
  // DELETE removed the right rows without touching the one it kept.
  const keeper = await db.consultationFile.findUniqueOrThrow({
    where: { id: "f3" },
    select: { data: true },
  });
  ok(
    "the surviving file's bytes are intact",
    keeper.data.length === big.length && Buffer.from(keeper.data).equals(Buffer.from(big)),
    `${keeper.data.length} of ${big.length} bytes`,
  );

  // EXACT accounting: the table holds bytes for the survivors and nothing else.
  // Deterministic — no vacuum, no ratios, no autovacuum timing.
  const [{ stored }] = await db.$queryRawUnsafe<{ stored: bigint }[]>(
    `SELECT COALESCE(SUM(octet_length("data")), 0) AS stored FROM "ConsultationFile"`,
  );
  const expected = big.length + 3; // the kept food-list + the untouched other-doc
  ok(
    "no bytes remain for the deleted rows (nothing orphaned)",
    Number(stored) === expected,
    `${Number(stored)} stored, expected ${expected}`,
  );

  // Re-applying the migration on already-clean data is a no-op.
  await db.$executeRawUnsafe(DEDUPE);
  ok("re-running the cleanup changes nothing", (await db.consultationFile.count()) === 2);
}

main().finally(() => db.$disconnect());
