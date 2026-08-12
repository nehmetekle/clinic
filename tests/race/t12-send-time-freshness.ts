/**
 * Two tabs. Tab A has the Files tab open with a fresh PDF; Tab B edits the Food
 * List. Tab A's `stale` flag is now wrong — it was accurate when the listing was
 * fetched — so the server has to refuse the send itself.
 *
 * Drives the real download route with a real session cookie, so auth, the intent
 * parameter and the freshness check are all exercised as a browser would.
 */
import { GET as downloadFile } from "../../src/app/api/consultation-files/[fileId]/route";
import { db } from "../../src/server/db";
import { createSession } from "../../src/server/session";
import { SESSION_COOKIE_NAME } from "../../src/server/session-constants";
import { generateFoodListPdf } from "../../src/server/services/foodListPdf";
import { listClientConsultationFiles } from "../../src/server/repositories/consultationFiles";
import { updateConsultation } from "../../src/server/repositories/consultations";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

let cookie = "";

/** One request from a signed-in browser tab. */
function request(fileId: string, intent?: "send") {
  const url = `http://localhost/api/consultation-files/${fileId}${intent ? `?intent=${intent}` : ""}`;
  return downloadFile(new Request(url, { headers: { cookie } }), {
    params: Promise.resolve({ fileId }),
  });
}

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  cookie = `${SESSION_COOKIE_NAME}=${await createSession(doctor.id)}`;

  await generateFoodListPdf(c.id, ACTOR);

  // --- Tab A loads the Files tab. Everything is current. ---
  const tabA = (await listClientConsultationFiles(client.id))[0];
  ok("Tab A sees a fresh file", tabA.stale === false);

  const freshSend = await request(tabA.id, "send");
  ok("fresh send is allowed", freshSend.status === 200, String(freshSend.status));
  const bytes = Buffer.from(await freshSend.arrayBuffer());
  ok("and returns the PDF", bytes.subarray(0, 5).toString() === "%PDF-", `${bytes.length} bytes`);

  // --- Tab B edits the Food List. Tab A is never refreshed. ---
  await updateConsultation(
    c.id,
    {
      clientId: client.id,
      foodList: {
        language: "en",
        patientName: "Race Patient",
        selections: ["vegetables.artichoke", "fruits.banana"],
      },
    },
    { actorName: ACTOR.name, actorEmail: ACTOR.email },
  );

  // --- Tab A sends without refreshing: its flag still says fresh ---
  ok("Tab A's cached flag is now wrong", tabA.stale === false);
  const staleSend = await request(tabA.id, "send");
  ok("the server refuses the stale send", staleSend.status === 409, String(staleSend.status));
  const body = (await staleSend.json()) as { error?: string; code?: string };
  ok("with a code the UI can act on", body.code === "stale_food_list", String(body.code));
  ok("and a message that says what to do", /Regenerate the PDF/i.test(body.error ?? ""), body.error ?? "");
  ok("no PDF bytes were handed out", !JSON.stringify(body).includes("%PDF"));

  // A plain download is untouched — staff may still fetch the old sheet on purpose.
  const plain = await request(tabA.id);
  ok("a plain download still works", plain.status === 200, String(plain.status));

  // --- regenerate, then Tab A's send works again ---
  const regenerated = await generateFoodListPdf(c.id, ACTOR);
  const afterSend = await request(regenerated.id, "send");
  ok("send works again after regenerating", afterSend.status === 200, String(afterSend.status));
  const newBytes = Buffer.from(await afterSend.arrayBuffer());
  ok("and it is the new PDF", newBytes.subarray(0, 5).toString() === "%PDF-" && !newBytes.equals(bytes));

  // The id is stable across regeneration, so even Tab A's old id now sends fine.
  ok("Tab A's stale link is live again too", (await request(tabA.id, "send")).status === 200);

  // --- unauthenticated requests still get nothing ---
  const anon = await downloadFile(
    new Request(`http://localhost/api/consultation-files/${tabA.id}?intent=send`),
    { params: Promise.resolve({ fileId: tabA.id }) },
  );
  ok("an unauthenticated send is rejected", anon.status === 403, String(anon.status));

  // --- the client asks with the intent, and reacts to the refusal ---
  const { readFileSync } = await import("node:fs");
  const button = readFileSync("src/components/SendViaWhatsAppButton.tsx", "utf8");
  ok("the send button uses the send-intent URL", /consultationFileSendUrl\(fileId\)/.test(button));
  ok("a 409 flips it to the regenerate notice", /res\.status === 409[\s\S]*?setRefused\(true\)/.test(button));
  ok("and no download is written on refusal", /setRefused\(true\);[\s\S]*?return;/.test(button));
  ok(
    "the chat still opens inside the gesture",
    button.indexOf("window.open(chatUrl") < button.indexOf("void sendDownload()"),
  );
}

main().finally(() => db.$disconnect());
