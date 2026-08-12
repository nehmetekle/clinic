/**
 * The dedupe step of migration 20260812140000 must keep the NEWEST file per
 * (consultation, kind) and leave nothing behind. PDF bytes live in the row
 * itself (`data Bytes`), so deleting a row is the whole story — there is no file
 * on disk to orphan — but this checks the storage actually goes away too.
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
  const big = new Uint8Array(300_000).fill(7); // large enough to be TOASTed
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

  const [{ total_bytes: before }] = await db.$queryRawUnsafe<{ total_bytes: bigint }[]>(
    `SELECT pg_total_relation_size('"ConsultationFile"') AS total_bytes`,
  );

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

  await db.$executeRawUnsafe(`VACUUM FULL "ConsultationFile"`);
  const [{ total_bytes: after }] = await db.$queryRawUnsafe<{ total_bytes: bigint }[]>(
    `SELECT pg_total_relation_size('"ConsultationFile"') AS total_bytes`,
  );
  ok(
    "the deleted rows' bytes are reclaimed (nothing orphaned)",
    Number(after) < Number(before) / 2,
    `${Number(before)} -> ${Number(after)} bytes`,
  );

  // Re-applying the migration on already-clean data is a no-op.
  await db.$executeRawUnsafe(DEDUPE);
  ok("re-running the cleanup changes nothing", (await db.consultationFile.count()) === 2);
}

main().finally(() => db.$disconnect());
