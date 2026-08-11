"use client";

import { AlertTriangle, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { foodListMessage, whatsAppChatUrl, WHATSAPP_BAD_PHONE_MESSAGE } from "@/lib/whatsapp";

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
 */
export function SendViaWhatsAppButton({
  fileId,
  filename,
  phone,
  firstName,
  className,
}: {
  fileId: string;
  filename: string;
  phone: string;
  firstName: string;
  className?: string;
}) {
  const chatUrl = whatsAppChatUrl(phone, foodListMessage(firstName));

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

  return (
    <a
      href={api.consultationFileUrl(fileId)}
      download={filename}
      onClick={() => {
        window.open(chatUrl, "_blank", "noopener,noreferrer");
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
