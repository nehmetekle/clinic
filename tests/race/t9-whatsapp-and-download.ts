/** Regression: the WhatsApp send path and the download it depends on. */
import { db } from "../../src/server/db";
import { whatsAppChatUrl } from "../../src/lib/whatsapp";
import { generateFoodListPdf } from "../../src/server/services/foodListPdf";
import { getConsultationFileForDownload, listClientConsultationFiles } from "../../src/server/repositories/consultationFiles";
import { ACTOR, makeClient, makeConsultationWithFoodList, makeDoctor, ok, resetDb } from "./harness";

async function main() {
  await resetDb();
  const doctor = await makeDoctor();
  const client = await makeClient();
  const c = await makeConsultationWithFoodList(client.id, doctor.id);
  const file = await generateFoodListPdf(c.id, ACTOR);

  const link = whatsAppChatUrl(client.phone, "Hello");
  ok(
    "builds a wa.me link for a dialable number",
    typeof link === "string" && link.startsWith("https://wa.me/96170123456?text="),
    String(link),
  );
  ok("still refuses a number with no country code", whatsAppChatUrl("03123456", "Hi") === null);
  ok("still refuses an impossible length", whatsAppChatUrl("+961701234567", "Hi") === null);

  const dl = await getConsultationFileForDownload(file.id);
  ok("the generated file downloads", !!dl && dl.data.subarray(0, 5).toString() === "%PDF-", `${dl?.data.length} bytes`);
  ok("filename is the send-ready one", dl?.filename === file.filename, dl?.filename ?? "");

  const tab = await listClientConsultationFiles(client.id);
  ok("it appears once on the client's Files tab", tab.filter((f) => f.kind === "food-list").length === 1);
  ok("listings never carry the blob", !("data" in (tab[0] as object)));

  // Regenerating keeps the Files tab at one row and the link still valid.
  await generateFoodListPdf(c.id, ACTOR);
  const tab2 = await listClientConsultationFiles(client.id);
  ok("still one row after regenerating", tab2.length === 1, `${tab2.length}`);
  ok("download still resolves after the in-place replace", !!(await getConsultationFileForDownload(tab2[0].id)));
  await db.$disconnect();
}
main();
