/**
 * #4 — a Food List PDF that no longer matches the form must not be sendable.
 *
 * Covers both halves: the server flag that detects it (`stale` on every file
 * listing, from the same `isFoodListPdfStale` the close-time catch-up uses) and
 * the button that acts on it, rendered for real with react-dom/server.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../../src/server/db";
import { generateFoodListPdf, ensureFoodListPdf } from "../../src/server/services/foodListPdf";
import { listClientConsultationFiles } from "../../src/server/repositories/consultationFiles";
import { updateConsultation } from "../../src/server/repositories/consultations";
import { isFoodListPdfStale } from "../../src/lib/food-list";
import { SendViaWhatsAppButton } from "../../src/components/SendViaWhatsAppButton";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

// createElement rather than JSX: these run through tsx/esbuild, and the project's
// tsconfig leaves JSX for Next to transform.
const button = (props: { stale: boolean }) =>
  renderToStaticMarkup(
    createElement(SendViaWhatsAppButton, {
      fileId: "file-1",
      filename: "Food List.pdf",
      phone: "+96170123456",
      firstName: "Race",
      stale: props.stale,
    }),
  );

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  const fileOf = async () =>
    (await listClientConsultationFiles(client.id)).find((f) => f.consultationId === c.id);

  // --- no PDF yet: nothing to send, nothing to warn about ---
  ok("no file listed before generating", (await fileOf()) === undefined);

  // --- fresh PDF: normal send ---
  await generateFoodListPdf(c.id, ACTOR);
  let file = await fileOf();
  ok("a freshly generated PDF is not stale", file?.stale === false, String(file?.stale));
  const fresh = button({ stale: file!.stale });
  // The wa.me URL is opened in the click handler (one user gesture, see §11), so
  // what the markup shows is the live download anchor and the send label.
  ok("fresh: the send button is live", fresh.includes("Send via WhatsApp") && !/Regenerate/i.test(fresh));
  ok("fresh: the file is downloadable from the button", fresh.includes("/api/consultation-files/file-1"));

  // --- doctor changes the form afterwards ---
  await updateConsultation(
    c.id,
    {
      clientId: client.id,
      foodList: {
        language: "en",
        patientName: "Race Patient",
        selections: ["vegetables.artichoke", "fruits.apple", "eggs-and-dairy.cows-milk", "fruits.banana"],
      },
    },
    { actorName: ACTOR.name, actorEmail: ACTOR.email },
  );
  file = await fileOf();
  ok("editing the form marks the PDF stale", file?.stale === true, String(file?.stale));
  const stale = button({ stale: file!.stale });
  ok("stale: the send affordance is gone", !stale.includes("Send via WhatsApp"));
  ok("stale: no download href either — the old PDF can't leave", !stale.includes("/api/consultation-files/"));
  ok("stale: it says what to do instead", /Regenerate/i.test(stale));

  // --- regenerate: sending works again, with the new PDF ---
  const regenerated = await generateFoodListPdf(c.id, ACTOR);
  file = await fileOf();
  ok("regenerating clears the stale flag", file?.stale === false, String(file?.stale));
  ok("and it is the regenerated file", file?.id === regenerated.id);
  const again = button({ stale: file!.stale });
  ok("send is live again", again.includes("Send via WhatsApp") && !/Regenerate/i.test(again));

  // --- unchanged form: nothing changes ---
  ok("re-reading an untouched visit still reports fresh", (await fileOf())?.stale === false);
  ok("close-time catch-up agrees there is nothing to do", (await ensureFoodListPdf(c.id, ACTOR)) === null);

  // --- the predicate is shared, not re-implemented ---
  const svc = await import("node:fs").then((fs) =>
    fs.readFileSync("src/server/services/foodListPdf.ts", "utf8"),
  );
  const repo = await import("node:fs").then((fs) =>
    fs.readFileSync("src/server/repositories/consultationFiles.ts", "utf8"),
  );
  ok("close-time check uses the shared predicate", /isFoodListPdfStale\(/.test(svc));
  ok("file listings use the same one", /isFoodListPdfStale\(/.test(repo));
  ok(
    "the predicate itself is right",
    isFoodListPdfStale(new Date(1), new Date(2)) &&
      !isFoodListPdfStale(new Date(2), new Date(1)) &&
      !isFoodListPdfStale(null, new Date(2)),
  );

  // --- the editor also catches edits that aren't saved yet ---
  const page = await import("node:fs").then((fs) =>
    fs.readFileSync("src/app/(app)/consultations/new/page.tsx", "utf8"),
  );
  ok("editor seeds staleness from the server flag", /setFoodListChangedSincePdf\(file\?\.stale \?\? false\)/.test(page));
  ok("editor marks any edit stale", /onChange=\{\(next\) => \{[\s\S]*?setFoodListChangedSincePdf\(true\)/.test(page));
  ok("generating clears it", /setFoodListChangedSincePdf\(false\)/.test(page));
  ok("and the card is told", /pdfStale=\{foodListPdfStale\}/.test(page));
}

main().finally(() => db.$disconnect());
