"use client";

import { useState } from "react";
import { AlertTriangle, Download, Loader2, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { ConsultationFile, Role } from "@/lib/types";
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
 * Pass `role` so a dietitian facing an undialable number gets a Download
 * fallback instead of the "check patient's phone" notice (see below); other
 * roles keep the notice, since only the dietitian can fix the phone or
 * regenerate the sheet.
 *
 * Freshness is checked twice. `stale` (the form was edited after this PDF was
 * made) hides the button, but that flag is only as current as the listing it came
 * from — a Files tab left open while the doctor edits the form elsewhere still
 * shows a live button. So the fetch that collects the bytes asks for them with
 * `?intent=send`, and the server refuses a superseded sheet; the flag is the
 * affordance, the server is the guarantee.
 *
 * `stale` used to just block the send with a "regenerate first" notice — that
 * was the safe default when regenerating had to be a separate button press.
 * Now, when the caller passes `onRegenerate` (only doctor/admin can — they're
 * the ones `POST .../food-list-pdf` allows), a stale file regenerates
 * transparently on click instead: the button stays live, just shows a spinner
 * while the fresh PDF renders, then sends/downloads that instead of the old
 * one. Callers that can't regenerate (no `onRegenerate`) still get the notice.
 */
export function SendViaWhatsAppButton({
  fileId,
  filename,
  phone,
  firstName,
  stale = false,
  role,
  onRegenerate,
  className,
}: {
  fileId: string;
  filename: string;
  phone: string;
  firstName: string;
  /** This PDF no longer matches the saved form (see `isFoodListPdfStale`). */
  stale?: boolean;
  /** The dietitian gets a Download fallback instead of the "check patient's
   * phone" notice when the number can't be dialled — a plain download still
   * gets the sheet into their hands even when WhatsApp can't. */
  role?: Role;
  /** Regenerates the PDF and resolves the fresh file. Only pass this when the
   * signed-in role is actually allowed to generate (doctor/admin) — a stale
   * file then refreshes itself on click instead of blocking. */
  onRegenerate?: () => Promise<ConsultationFile | null | undefined>;
  className?: string;
}) {
  const chatUrl = whatsAppChatUrl(phone, foodListMessage(firstName));
  const { toast } = useToast();
  // Set when the server turns the send down — the listing this button was drawn
  // from is out of date, so flip it to the same "needs a fresh copy" state a
  // stale file starts in.
  const [refused, setRefused] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const needsFreshCopy = stale || refused;

  // Resolves the file to actually act on: regenerates first when the current
  // copy is superseded and the caller is allowed to (`onRegenerate` given).
  async function resolveFile(): Promise<{ id: string; filename: string } | null> {
    if (!needsFreshCopy) return { id: fileId, filename };
    if (!onRegenerate) return null;
    setRegenerating(true);
    try {
      const file = await onRegenerate();
      if (!file) return null; // onRegenerate already reported why
      setRefused(false);
      return { id: file.id, filename: file.filename };
    } finally {
      setRegenerating(false);
    }
  }

  // The form moved on after this sheet was printed, and nobody here can
  // regenerate it: sending it would hand the patient answers the doctor has
  // already changed, so show what to do instead of a dead button.
  if (needsFreshCopy && !onRegenerate) {
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
  // one) and risk opening a chat with a stranger, show what to fix. The
  // dietitian gets a plain Download instead — the sheet still needs to reach
  // the patient somehow, and a downloaded PDF doesn't depend on the phone
  // field at all. Every other role keeps the phone-fix notice, since they
  // can't generate a replacement if the download turns out to be stale later.
  if (!chatUrl) {
    if (role === "dietitian") {
      return (
        <a
          href={api.consultationFileUrl(fileId)}
          download={filename}
          title="This patient's phone number isn't set up for WhatsApp — download the PDF instead."
          aria-disabled={regenerating}
          onClick={(e) => {
            if (!needsFreshCopy) return; // plain link, let the browser download it
            e.preventDefault();
            if (regenerating) return;
            void (async () => {
              const file = await resolveFile();
              if (!file) {
                toast("Couldn't regenerate the PDF.");
                return;
              }
              const a = document.createElement("a");
              a.href = api.consultationFileUrl(file.id);
              a.download = file.filename;
              a.click();
            })();
          }}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50",
            regenerating && "pointer-events-none opacity-50",
            className,
          )}
        >
          {regenerating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {regenerating ? "Regenerating…" : "Download"}
        </a>
      );
    }
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
   * this listing is simply old): no bytes are written, and — for callers that
   * can't regenerate — the button becomes the "regenerate first" notice.
   */
  async function sendDownload(id: string, name: string) {
    try {
      const res = await fetch(api.consultationFileSendUrl(id));
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
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("Couldn't download the PDF — open it with Print and save it from there.");
    }
  }

  return (
    <a
      // Kept as a real link (middle-click, right-click "Save as") — the click
      // handler takes over so a refusal (or a needed regenerate) can be
      // handled instead of dumping the error JSON into the browser as a download.
      href={api.consultationFileUrl(fileId)}
      download={filename}
      aria-disabled={regenerating}
      onClick={(e) => {
        if (regenerating) {
          e.preventDefault();
          return;
        }
        // Opening the chat must stay in the gesture — an await here and the
        // pop-up blocker eats the window. Regenerating (if needed) and the
        // download both follow asynchronously.
        window.open(chatUrl, "_blank", "noopener,noreferrer");
        e.preventDefault();
        void (async () => {
          const file = await resolveFile();
          if (!file) {
            toast("Couldn't regenerate the PDF.");
            return;
          }
          await sendDownload(file.id, file.filename);
        })();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50",
        regenerating && "pointer-events-none opacity-50",
        className,
      )}
    >
      {regenerating ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <MessageCircle className="h-4 w-4" />
      )}
      {regenerating ? "Regenerating…" : "Send via WhatsApp"}
    </a>
  );
}

/** The standing caveat, so both hosts word the limitation identically. */
export const WHATSAPP_ATTACH_HINT =
  "Downloads the PDF and opens WhatsApp on the patient's number — attach the downloaded file in WhatsApp to send it.";
