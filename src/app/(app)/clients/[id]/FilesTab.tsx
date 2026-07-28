"use client";

import { Download, FileText, FlaskConical, Salad } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { formatFileSize } from "@/lib/files";

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
 */
export function FilesTab({ clientId }: { clientId: string }) {
  const { user } = useSession();
  const isClinical = user?.role === "dietitian" || user?.role === "admin";

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
                <a
                  href={api.consultationFileUrl(f.id)}
                  download={f.filename}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
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
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
          Uploading general (non blood-test) documents arrives in Version 4. Blood-test
          results are uploaded from the Blood tests tab or the Blood Samples board; the
          Food List PDF is generated from the consultation editor.
        </p>
      </CardBody>
    </Card>
  );
}
