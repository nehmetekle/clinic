"use client";

import { useState } from "react";
import { Download, Eye, FileText, FlaskConical, Loader2, Salad } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { cn, formatDate } from "@/lib/utils";
import { formatFileSize } from "@/lib/files";
import { SendViaWhatsAppButton } from "@/components/SendViaWhatsAppButton";

/**
 * The client profile's Files tab.
 *
 * Two kinds of attachment land here, with deliberately different access:
 * - **Consultation documents** (the generated Food List PDF) — visible to every
 *   role, since the finished printout is handed to the patient at the front desk.
 * - **Blood-test results** — clinical data, so only the doctor/admin sees them at
 *   all; the endpoint behind them is gated on `canViewClinical`, and this tab
 *   simply doesn't ask for them as a secretary.
 *
 * Uploads still happen in context (the Blood Samples board / Blood tests tab, and
 * the consultation editor for the Food List) — this tab is read-only. General,
 * ad-hoc file upload remains a Version 4 item, noted below.
 *
 * Food List rows also carry "Send via WhatsApp" (all three roles), which needs
 * the patient's phone and first name — hence those props rather than fetching
 * the client again here, since the profile page above already has them.
 */
export function FilesTab({
  clientId,
  clientPhone,
  clientFirstName,
}: {
  clientId: string;
  clientPhone: string;
  clientFirstName: string;
}) {
  const { user } = useSession();
  const isClinical = user?.role === "dietitian" || user?.role === "admin";
  // Only doctor/admin can regenerate (`POST .../food-list-pdf` is clinical-only)
  // — matches `isClinical`, named separately since the two checks mean different
  // things here (one gates *seeing* labs, the other gates *fixing* a stale PDF).
  const canRegenerate = isClinical;
  const { toast } = useToast();
  const [printRegeneratingId, setPrintRegeneratingId] = useState<string | null>(null);

  const consultationFiles = useApi(
    () => api.listClientConsultationFiles(clientId),
    [clientId],
  );
  const bloodFiles = useApi(
    () => (isClinical ? api.listClientBloodFiles(clientId) : Promise.resolve([])),
    [clientId, isClinical],
  );

  if (consultationFiles.loading || bloodFiles.loading) return <Loading />;
  const error = consultationFiles.error ?? bloodFiles.error;
  if (error) return <ErrorState message={error} />;

  // Regenerates a row's PDF and refreshes the listing so its `stale`/`createdAt`
  // catch up — used by both Print (below) and the Download/Send button's
  // `onRegenerate`.
  async function regenerate(consultationId: string) {
    const file = await api.generateFoodListPdf(consultationId);
    consultationFiles.refetch();
    return file;
  }

  const docs = consultationFiles.data ?? [];
  const labs = bloodFiles.data ?? [];
  const empty = docs.length === 0 && labs.length === 0;

  return (
    <Card>
      <CardHeader
        title="Files"
        subtitle={
          isClinical
            ? "Documents generated for this patient, and lab results attached to their blood tests"
            : "Documents generated for this patient"
        }
      />
      <CardBody>
        {empty ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No files yet.{" "}
            {isClinical
              ? "Generated forms and uploaded lab results appear here."
              : "Forms generated during a consultation appear here."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {docs.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                <span className="flex min-w-0 items-center gap-3">
                  <FileText className="h-5 w-5 shrink-0 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-700">
                      {f.filename}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {formatFileSize(f.size)} · {formatDate(f.createdAt)} · {f.uploadedByName}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
                      <Salad className="h-3 w-3" />
                      Food List · Visit #{f.visitNumber} · {formatDate(f.visitDate)}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {/* Print, not Download: this sheet's purpose is a printout
                      handed to the patient at the desk. Opens the PDF inline in
                      a new tab — the browser's viewer owns the print dialog —
                      and stays a real link, so "Save as" is still one
                      right-click away for anyone who wants the file. If it's
                      stale and this role can regenerate, the click reserves the
                      tab synchronously (so the pop-up blocker leaves it alone),
                      regenerates, then points the reserved tab at the fresh copy. */}
                  <a
                    href={api.consultationFilePrintUrl(f.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={printRegeneratingId === f.id}
                    onClick={
                      canRegenerate && f.stale
                        ? (e) => {
                            e.preventDefault();
                            if (printRegeneratingId) return;
                            const win = window.open("", "_blank");
                            setPrintRegeneratingId(f.id);
                            void (async () => {
                              try {
                                const file = await regenerate(f.consultationId);
                                if (win) win.location.href = api.consultationFilePrintUrl(file.id);
                                else toast("Couldn't open the print tab — check your pop-up blocker.");
                              } catch (e) {
                                win?.close();
                                toast((e as Error).message);
                              } finally {
                                setPrintRegeneratingId(null);
                              }
                            })();
                          }
                        : undefined
                    }
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50",
                      printRegeneratingId === f.id && "pointer-events-none opacity-50",
                    )}
                  >
                    {printRegeneratingId === f.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    {printRegeneratingId === f.id ? "Regenerating…" : "View"}
                  </a>
                  {/* Food List forms are what gets sent on to the patient; a lab
                      result is clinical and is never WhatsApp'd from here. */}
                  {f.kind === "food-list" && (
                    <SendViaWhatsAppButton
                      fileId={f.id}
                      filename={f.filename}
                      phone={clientPhone}
                      firstName={clientFirstName}
                      stale={f.stale}
                      role={user?.role}
                      onRegenerate={canRegenerate ? () => regenerate(f.consultationId) : undefined}
                    />
                  )}
                </span>
              </li>
            ))}
            {labs.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                <span className="flex min-w-0 items-center gap-3">
                  <FileText className="h-5 w-5 shrink-0 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-700">
                      {f.filename}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {formatFileSize(f.size)} · {formatDate(f.createdAt)} · {f.uploadedByName}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
                      <FlaskConical className="h-3 w-3" />
                      Blood test · {formatDate(f.orderedAt)}
                      {f.tests.length > 0 ? ` · ${f.tests.join(", ")}` : ""}
                    </span>
                  </span>
                </span>
                <a
                  href={api.bloodSampleFileUrl(f.id)}
                  download={f.filename}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
