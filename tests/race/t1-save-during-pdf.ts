/**
 * #1 — clicking Save / Close during the window where the internal save has
 * finished but the PDF is still rendering (and the URL hasn't adopted the new
 * consultation id yet).
 *
 * Mirrors the consultation editor's control flow (src/app/(app)/consultations/
 * new/page.tsx: `save`, `generateFoodListPdf`) against the real repositories, so
 * the damage measured here is the damage a doctor would get. The button-enabled
 * rule is the one variable: `pre-fix` = disabled only while `saving`, `post-fix`
 * = disabled while `saving || generatingPdf`.
 */
import { db } from "../../src/server/db";
import { createConsultation, updateConsultation, closeConsultation } from "../../src/server/repositories/consultations";
import { generateFoodListPdf } from "../../src/server/services/foodListPdf";
import { ACTOR, makeClient, makeDoctor, ok, resetDb } from "./harness";
import { readFileSync } from "node:fs";

type Mode = "pre-fix" | "post-fix";

/** The editor's state machine, as far as Save / Generate PDF are concerned. */
class Editor {
  saving = false;
  generatingPdf = false;
  editId = "";
  /** Post-fix synchronous re-entry guard (the `ref` in the real component). */
  inFlight = false;
  saved = false; // "Consultation saved" screen shown to the doctor
  toasts: string[] = [];

  constructor(readonly mode: Mode, readonly clientId: string, readonly dietitianId: string) {}

  /** What `disabled=` evaluates to for Save / Save & Close / Close visit. */
  get buttonsDisabled() {
    return this.mode === "pre-fix" ? this.saving : this.saving || this.generatingPdf;
  }

  async save(close: boolean, { silent = false, notes = "first save" } = {}): Promise<string | null> {
    if (this.mode === "post-fix" && this.inFlight) return null; // guard: ignore re-entry
    this.inFlight = true;
    this.saving = true;
    try {
      const input = { clientId: this.clientId, dietitianId: this.dietitianId, notes };
      const saved = this.editId
        ? await updateConsultation(this.editId, input, { actorName: ACTOR.name, actorEmail: ACTOR.email })
        : await createConsultation(input, { close, actorName: ACTOR.name, actorEmail: ACTOR.email });
      if (this.editId && close) {
        await closeConsultation(this.editId, { actorName: ACTOR.name, actorEmail: ACTOR.email });
      }
      if (!silent) {
        this.toasts.push(close ? "Visit closed" : "Saved — visit in progress");
        this.saved = true;
      }
      return saved.id;
    } catch (e) {
      this.toasts.push((e as Error).message);
      return null;
    } finally {
      this.saving = false;
      this.inFlight = false;
    }
  }

  async generatePdf() {
    this.generatingPdf = true;
    try {
      const id = await this.save(false, { silent: true, notes: "first save" });
      if (!id) return;
      await db.consultationFoodList.upsert({
        where: { consultationId: id },
        create: {
          consultationId: id,
          language: "en",
          patientName: "Race Patient",
          selections: JSON.stringify(["fruits.apple", "vegetables.artichoke"]),
        },
        update: {},
      });
      await generateFoodListPdf(id, ACTOR);
      if (!this.editId) this.editId = id; // router.replace(...) adopting the new id
    } finally {
      this.generatingPdf = false;
    }
  }

  /** Resolves once the editor is in the gap: save done, PDF still running. */
  async waitForGap(): Promise<boolean> {
    for (let i = 0; i < 2000; i++) {
      if (!this.saving && this.generatingPdf && !this.editId) return true;
      if (!this.generatingPdf) return false; // PDF finished before we got there
      await new Promise((r) => setTimeout(r, 1));
    }
    return false;
  }
}

async function scenario(mode: Mode, click: "save" | "close") {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const ed = new Editor(mode, client.id, doctor.id);

  const pdf = ed.generatePdf();
  const inGap = await ed.waitForGap();
  let clicked = false;
  if (inGap && !ed.buttonsDisabled) {
    clicked = true;
    await ed.save(click === "close", { notes: "EDITS MADE DURING THE GAP" });
  }
  await pdf;

  const visits = await db.consultation.findMany({ where: { clientId: client.id } });
  const files = await db.consultationFile.count();
  return { ed, inGap, clicked, visits, files };
}

async function main() {
  for (const mode of ["pre-fix", "post-fix"] as Mode[]) {
    for (const click of ["save", "close"] as const) {
      const { ed, inGap, clicked, visits, files } = await scenario(mode, click);
      console.log(`\n[${mode}] click "${click}" inside the PDF window`);
      console.log(`  ..    reached the gap: ${inGap}; button clickable: ${clicked}`);
      console.log(`  ..    visits=${visits.length} status=${visits.map((v) => v.status).join(",")} notes=${JSON.stringify(visits.map((v) => v.notes))} files=${files} toasts=${JSON.stringify(ed.toasts)}`);
      const v = visits[0];
      if (mode === "pre-fix") {
        console.log(`  ..    doctor was told: ${JSON.stringify(ed.toasts)}; DB says status=${v?.status}, notes=${JSON.stringify(v?.notes)}`);
      }
      if (mode === "post-fix") {
        ok("the click is refused while the PDF is generating", !clicked);
        ok("exactly one visit exists", visits.length === 1, `${visits.length}`);
        ok("exactly one Food List PDF", files === 1, `${files}`);
        ok("no misleading toast shown", ed.toasts.length === 0, JSON.stringify(ed.toasts));
      } else {
        ok("(pre-fix) reproduces: click lands in the gap", clicked);
        if (click === "close") {
          ok(
            "(pre-fix) DAMAGE: 'Visit closed' reported but the visit is still open",
            v?.status === "open" && ed.toasts.includes("Visit closed"),
          );
        } else {
          ok(
            "(pre-fix) DAMAGE: 'Saved' reported but the gap edits were dropped",
            v?.notes !== "EDITS MADE DURING THE GAP" && ed.toasts.some((t) => t.startsWith("Saved")),
            `notes=${JSON.stringify(v?.notes)}`,
          );
        }
      }
    }
  }

  // Probe: two first-saves genuinely in flight together (rapid double-click on a
  // brand-new visit, before any re-render can disable the button).
  {
    await resetDb();
    const doctor = await makeDoctor();
    const client = await makeClient();
    const input = { clientId: client.id, dietitianId: doctor.id };
    await Promise.allSettled([
      createConsultation(input, { actorName: ACTOR.name, actorEmail: ACTOR.email }),
      createConsultation(input, { actorName: ACTOR.name, actorEmail: ACTOR.email }),
    ]);
    const visits = await db.consultation.findMany({ where: { clientId: client.id } });
    console.log(`\n[probe] two concurrent first saves -> visits=${visits.length} visitNumbers=${visits.map((v) => v.visitNumber).join(",")}`);
  }

  // Source-truth check: the real buttons must carry the same guard the
  // post-fix simulation assumes.
  const page = readFileSync("src/app/(app)/consultations/new/page.tsx", "utf8");
  const disabledExprs = [...page.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1].trim());
  const writeButtons = disabledExprs.filter((e) => /\bbusy\b|\bsaving\b/.test(e) && !/savingSupp/.test(e));
  ok(
    "the busy flag covers the whole PDF chain",
    /const busy = saving \|\| generatingPdf;/.test(page),
    "busy = saving || generatingPdf",
  );
  ok(
    "every write button (Save / Close / Delete) is gated on it",
    writeButtons.length >= 3 && writeButtons.every((e) => /\bbusy\b/.test(e)),
    writeButtons.join(" ;; ") || "no gated buttons found",
  );
  ok(
    "save() refuses re-entry synchronously",
    /if \(writeInFlightRef\.current\) return null;/.test(page),
  );
}

main().finally(() => db.$disconnect());
