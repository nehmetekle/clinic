/**
 * #6 — a Food List PDF that fails in production must leave a trace.
 *
 * Failures stay silent for the user (deliberate: the visit has already closed),
 * so the only thing standing between "broken font on the server" and "nobody
 * noticed for a month" is a structured error line. Failures are forced for real
 * — a trigger that rejects the file write — rather than mocked, and the trigger's
 * message deliberately quotes the patient's name so the redaction is tested too.
 */
import { db } from "../../src/server/db";
import { generateFoodListPdf, ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { closeConsultation, updateConsultation } from "../../src/server/repositories/consultations";
import { ACTOR, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

const PATIENT = { first: "Race", last: "Patient" };

/** Captures the structured lines written to console.error while `run` executes. */
async function capture(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

async function blockFileWrites() {
  // RAISE quotes the filename, which carries the patient's name — the realistic
  // way clinical data leaks into a log line.
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION race_test_block_file() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'disk full while writing %', NEW.filename; END;
    $$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER race_test_block_file BEFORE INSERT OR UPDATE ON "ConsultationFile"
    FOR EACH ROW EXECUTE FUNCTION race_test_block_file();
  `);
}
async function unblockFileWrites() {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_test_block_file ON "ConsultationFile"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_test_block_file()`);
}

function isPdfFailure(e: Record<string, unknown>) {
  return e.event === "food_list_pdf.failed";
}

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await db.client.create({
    data: { firstName: PATIENT.first, lastName: PATIENT.last, phone: "+96170123456" },
  });
  const c1 = await makeConsultationWithFoodList(client.id, doctor.id);

  // --- success emits nothing ---
  const quiet = await capture(() => generateFoodListPdf(c1.id, ACTOR));
  ok("a successful generation emits no failure event", quiet.filter(isPdfFailure).length === 0, JSON.stringify(quiet));

  // --- manual generation failure ---
  await blockFileWrites();
  let threw = false;
  // The route lets this reach handleError (500); the test only needs the lines.
  const manual = await capture(async () => {
    await generateFoodListPdf(c1.id, ACTOR).catch(() => {
      threw = true;
    });
  });
  const m = manual.filter(isPdfFailure);
  ok("manual failure emits exactly one event", m.length === 1, JSON.stringify(m));
  ok("event names the visit", m[0]?.consultationId === c1.id);
  ok("event names the trigger", m[0]?.trigger === "manual", String(m[0]?.trigger));
  ok("event names the stage", m[0]?.stage === "store", String(m[0]?.stage));
  ok("event carries the error type", m[0]?.errorName !== undefined, String(m[0]?.errorName));
  ok("manual failure still surfaces to the caller", threw);

  // --- no clinical content in the payload ---
  const payload = JSON.stringify(m[0] ?? {});
  ok("no patient name in the payload", !payload.includes(PATIENT.first) && !payload.includes(PATIENT.last), payload);
  ok("no phone number in the payload", !payload.includes("96170123456"));
  ok("no food-list answers in the payload", !/artichoke|apple|cows-milk/.test(payload));
  ok("the filename that quoted the name is redacted", payload.includes("[redacted]"), payload);
  ok("selection COUNT is kept (shape, not content)", typeof m[0]?.selectionCount === "number" || m[0]?.stage !== "render");

  // --- auto-generate-on-close failure, and the close still completes ---
  const c2 = await makeConsultationWithFoodList(client.id, doctor.id);
  await db.consultation.update({ where: { id: c2.id }, data: { consultationFee: 50 } });
  await updateConsultation(c2.id, { clientId: client.id, waiveConsultationFee: true }, {
    actorName: ACTOR.name,
    actorEmail: ACTOR.email,
  });
  let closeThrew = false;
  const auto = await capture(async () => {
    await closeConsultation(c2.id, { actorName: ACTOR.name, actorEmail: ACTOR.email });
    await ensureFoodListPdf(c2.id, ACTOR).catch(() => {
      closeThrew = true;
    });
  });
  const a = auto.filter(isPdfFailure);
  ok("auto-on-close failure emits exactly one event", a.length === 1, JSON.stringify(a));
  ok("event says it came from the close path", a[0]?.trigger === "close", String(a[0]?.trigger));
  ok("event names the visit", a[0]?.consultationId === c2.id);
  ok("catch-up still swallows the error (best effort)", !closeThrew);

  const closed = await db.consultation.findUniqueOrThrow({ where: { id: c2.id } });
  ok("the visit is closed despite the PDF failing", closed.status === "closed" && closed.closedAt !== null);
  ok("no file was attached", (await db.consultationFile.count({ where: { consultationId: c2.id } })) === 0);

  // --- the render stage: the realistic production fault (asset missing from the
  // deployment, e.g. outputFileTracingIncludes not updated after a file move) ---
  // Runs in a child process because the renderer caches fonts per process, so a
  // process that already rendered successfully would never re-read them.
  {
    // No top-level await: the project isn't an ESM package, so tsx runs this as CJS.
    const script = `
      import { generateFoodListPdf } from "../../src/server/services/foodListPdf";
      const original = console.error;
      const lines: string[] = [];
      console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
      generateFoodListPdf(process.argv[2], { name: "Dr Test" })
        .catch(() => {})
        .then(() => {
          console.error = original;
          console.log("PROBE:" + JSON.stringify(lines));
          process.exit(0);
        });
    `;
    const { writeFileSync, rmSync, renameSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    writeFileSync("tests/race/.render-probe.ts", script);
    renameSync("src/server/pdf/fonts", "src/server/pdf/fonts.away");
    let out = "[]";
    try {
      out = execFileSync("npx", ["tsx", "tests/race/.render-probe.ts", c1.id], {
        encoding: "utf8",
        env: { ...process.env },
      });
    } catch {
      /* the child exits non-zero on some Node versions; the JSON is still on stdout */
    } finally {
      renameSync("src/server/pdf/fonts.away", "src/server/pdf/fonts");
      rmSync("tests/race/.render-probe.ts", { force: true });
    }
    const probeLine = out.split("\n").find((l) => l.startsWith("PROBE:")) ?? "PROBE:[]";
    const events = (JSON.parse(probeLine.slice("PROBE:".length)) as string[])
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null && isPdfFailure(x));
    ok("a missing font asset emits a failure event", events.length === 1, JSON.stringify(events));
    ok("stage is render", events[0]?.stage === "render", String(events[0]?.stage));
    ok("event carries the edition", events[0]?.language === "en", String(events[0]?.language));
    ok(
      "event carries the tick COUNT, never the ticks",
      events[0]?.selectionCount === 3 && !/artichoke|apple|cows-milk/.test(JSON.stringify(events[0])),
      String(events[0]?.selectionCount),
    );
    ok("error names the missing file", /ENOENT|no such file/i.test(String(events[0]?.errorMessage)));
  }

  // --- and the report itself can't break anything ---
  await unblockFileWrites();
  const recovered = await generateFoodListPdf(c2.id, ACTOR);
  ok("generation works again once the fault clears", !!recovered.id);
}

main()
  .finally(unblockFileWrites)
  .finally(() => db.$disconnect());
