"use client";

import { Download, FileText, FlaskConical } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Loading, ErrorState } from "@/components/ui/States";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { formatFileSize } from "@/lib/files";

/**
 * The client profile's Files tab. For now it surfaces every file attached to the
 * patient's blood tests (read-only here — uploads happen in the blood-test
 * context: the Blood Samples board or the Blood tests tab). General, non-blood
 * file upload/download remains a Version 4 item, noted below.
 */
export function FilesTab({ clientId }: { clientId: string }) {
  const { data, loading, error } = useApi(() => api.listClientBloodFiles(clientId), [clientId]);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  const files = data ?? [];

  return (
    <Card>
      <CardHeader title="Files" subtitle="Lab results attached to this patient's blood tests" />
      <CardBody>
        {files.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No files yet. Lab results uploaded against a blood test appear here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {files.map((f) => (
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
          results are uploaded from the Blood tests tab or the Blood Samples board.
        </p>
      </CardBody>
    </Card>
  );
}
