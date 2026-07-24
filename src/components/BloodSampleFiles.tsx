"use client";

import { useRef, useState } from "react";
import { Download, FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/use-api";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatDate } from "@/lib/utils";
import type { BloodSampleStatus } from "@/lib/types";
import {
  ALLOWED_BLOOD_FILE_LABEL,
  ALLOWED_BLOOD_FILE_TYPES,
  BLOOD_FILE_ACCEPT,
  MAX_BLOOD_FILE_BYTES,
  formatFileSize,
} from "@/lib/files";
import { cn } from "@/lib/utils";

const ALLOWED = new Set<string>(ALLOWED_BLOOD_FILE_TYPES);

/**
 * Files attached to one blood test — lab-result PDFs / scans. Reused on the Blood
 * Samples board and the client profile's Blood tests tab. Permissions are derived
 * from the signed-in role and mirror the server: secretary/doctor/admin may upload
 * and see that a file exists; only doctor/admin may download the content or delete
 * (enforced server-side too — this only shapes the UI).
 *
 * Result files are lab results, so uploading is only offered once the sample's
 * results are in (`status === "received"`). Before that the section is hidden
 * unless a file already exists (so a stray earlier upload stays visible/removable).
 */
export function BloodSampleFiles({
  sampleId,
  status,
  className,
}: {
  sampleId: string;
  status: BloodSampleStatus;
  className?: string;
}) {
  const { user } = useSession();
  const { toast } = useToast();
  const { data, loading, refetch } = useApi(() => api.listBloodSampleFiles(sampleId), [sampleId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const role = user?.role;
  // Uploading is only meaningful once the results are back — lab result files
  // can't exist before the sample has been received.
  const resultsIn = status === "received";
  const isUploaderRole = role === "secretary" || role === "dietitian" || role === "admin";
  const canUpload = resultsIn && isUploaderRole;
  const canReadContent = role === "dietitian" || role === "admin";
  // Doctor/admin can delete any file; an uploader can remove their own wrong upload
  // (allowed regardless of status, so a mistaken file is never stuck).
  const canDelete = (f: { uploadedById: string | null }) =>
    canReadContent || (isUploaderRole && !!user?.id && f.uploadedById === user.id);

  const files = data ?? [];

  // Before results are in there's nothing to upload; keep the board tidy by not
  // showing the section at all unless a file somehow already exists (then it stays
  // visible so it can be reviewed/removed). Once results are in, always show it.
  if (!resultsIn && files.length === 0) return null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset immediately so re-picking the same file still fires onChange.
    e.target.value = "";
    if (!file) return;

    if (!ALLOWED.has(file.type)) {
      toast(`Unsupported file type — use ${ALLOWED_BLOOD_FILE_LABEL}.`);
      return;
    }
    if (file.size === 0) {
      toast("That file is empty.");
      return;
    }
    if (file.size > MAX_BLOOD_FILE_BYTES) {
      toast("File is too large (max 10 MB).");
      return;
    }

    setBusy(true);
    try {
      await api.uploadBloodSampleFile(sampleId, file);
      toast(`Attached ${file.name}`);
      refetch();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteBloodSampleFile(id);
      toast("File deleted");
      refetch();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("rounded-lg border border-slate-200 bg-slate-50/60 p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <Paperclip className="h-3.5 w-3.5 text-slate-400" />
          Result files{files.length > 0 ? ` (${files.length})` : ""}
        </span>
        {canUpload && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Upload
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={BLOOD_FILE_ACCEPT}
              className="hidden"
              onChange={onPick}
            />
          </>
        )}
      </div>

      {loading ? (
        <p className="mt-2 text-xs text-slate-400">Loading…</p>
      ) : files.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">
          {canUpload ? "No files yet — attach a lab result." : "No files attached."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-slate-700">
                    {f.filename}
                  </span>
                  <span className="block truncate text-[11px] text-slate-400">
                    {formatFileSize(f.size)} · {formatDate(f.createdAt)} · {f.uploadedByName}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {canReadContent && (
                  <a
                    href={api.bloodSampleFileUrl(f.id)}
                    download={f.filename}
                    className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
                    aria-label={`Download ${f.filename}`}
                    title="Download"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                )}
                {canDelete(f) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDelete(f.id, f.filename)}
                    className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Remove ${f.filename}`}
                    title="Remove file"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
