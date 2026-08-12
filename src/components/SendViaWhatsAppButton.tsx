"use client";

import { useState } from "react";
import { AlertTriangle, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  foodListMessage,
  whatsAppChatUrl,
  WHATSAPP_BAD_PHONE_MESSAGE,
  WHATSAPP_STALE_MESSAGE,
} from "@/lib/whatsapp";

/**
 * "Send via WhatsApp" for a generated Food List PDF — shown everywhere the PDF
 * can be downloaded (the consultation editor's Food List card and the client
 * profile's Files tab).
 *
 * One click does the two things a person would otherwise do by hand: downloads
 * the PDF, and opens WhatsApp on this patient's number with a short message
 * ready to send. **It cannot attach the file** — WhatsApp exposes no way for a
 * web page to put an attachment in a chat, so the last step (drag the downloaded
 * file in, or use WhatsApp's paperclip) is the sender's. The caption under the
 * button says this outright; don't reword it into a promise the platform can't
 * keep.
 *
 * Both actions fire synchronously inside the click, with no `await` between
 * them: the moment this handler yields, the browser stops treating the
 * `window.open` as user-initiated and the pop-up blocker eats the chat window.
 * That's also why the component takes an already-generated file rather than
 * generating one on demand.
 *
 * Open to every role — the secretary hands the form over at the desk as often as
 * the doctor does. Only *generating* the PDF is clinical-only.
 *
 * Freshness is checked twice. `stale` (the form was edited after this PDF was
 * made) hides the button, but that flag is only as current as the listing it came
 * from — a Files tab left open while the doctor edits the form elsewhere still
 * shows a live button. So the fetch that collects the bytes asks for them with
 * `?intent=send`, and the server refuses a superseded sheet; the flag is the
 * affordance, the server is the guarantee.
 *
 * `stale` blocks the send instead of regenerating on the way out: regenerating means awaiting the server, and the
 * moment this handler yields the pop-up blocker eats the chat window — the same
 * one-gesture constraint that already rules out generating on demand here. So the
 * button turns into a "regenerate first" notice, which also keeps the doctor (not
 * a background request) in charge of what the patient receives.
 */
export function SendViaWhatsAppButton({
  fileId,
  filename,
  phone,
  firstName,
  stale = false,
  className,
}: {
  fileId: string;
  filename: string;
  phone: string;
  firstName: string;
  /** This PDF no longer matches the saved form (see `isFoodListPdfStale`). */
  stale?: boolean;
  className?: string;
}) {
  const chatUrl = whatsAppChatUrl(phone, foodListMessage(firstName));
  const { toast } = useToast();
  // Set when the server turns the send down — the listing this button was drawn
  // from is out of date, so flip it to the same notice a stale file gets.
  const [refused, setRefused] = useState(false);

  // The form moved on after this sheet was printed: sending it would hand the
  // patient answers the doctor has already changed.
  if (stale || refused) {
    return (
      <span
        title={WHATSAPP_STALE_MESSAGE}
        className={cn(
          "inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-amber-600",
          className,
        )}
      >
        <AlertTriangle className="h-4 w-4" />
        <span className="hidden sm:inline">Regenerate the PDF before sending</span>
        <span className="sm:hidden">Regenerate first</span>
      </span>
    );
  }

  // No dialable number: rather than guess a country code (or dial an impossible
  // one) and risk opening a chat with a stranger, show what to fix.
  if (!chatUrl) {
    return (
      <span
        title={WHATSAPP_BAD_PHONE_MESSAGE}
        className={cn(
          "inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-amber-600",
          className,
        )}
      >
        <AlertTriangle className="h-4 w-4" />
        <span className="hidden sm:inline">Can&apos;t send — check patient&apos;s phone</span>
        <span className="sm:hidden">Check phone</span>
      </span>
    );
  }

  /**
   * Fetches the PDF for sending and hands it to the browser as a download.
   * A 409 means the form moved on since this file was rendered (another tab, or
   * this listing is simply old): no bytes are written, and the button becomes the
   * "regenerate first" notice.
   */
  async function sendDownload() {
    try {
      const res = await fetch(api.consultationFileSendUrl(fileId));
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRefused(true);
        toast(body.error ?? WHATSAPP_STALE_MESSAGE);
        return;
      }
      if (!res.ok) {
        toast("Couldn't download the PDF — open it with Print and save it from there.");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("Couldn't download the PDF — open it with Print and save it from there.");
    }
  }

  return (
    <a
      // Kept as a real link (middle-click, right-click "Save as") — the click
      // handler takes over so a refusal can be reported instead of dumping the
      // error JSON into the browser as a download.
      href={api.consultationFileUrl(fileId)}
      download={filename}
      onClick={(e) => {
        // Opening the chat must stay in the gesture — an await here and the
        // pop-up blocker eats the window. The download follows asynchronously.
        window.open(chatUrl, "_blank", "noopener,noreferrer");
        e.preventDefault();
        void sendDownload();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50",
        className,
      )}
    >
      <MessageCircle className="h-4 w-4" /> Send via WhatsApp
    </a>
  );
}

/** The standing caveat, so both hosts word the limitation identically. */
export const WHATSAPP_ATTACH_HINT =
  "Downloads the PDF and opens WhatsApp on the patient's number — attach the downloaded file in WhatsApp to send it.";
