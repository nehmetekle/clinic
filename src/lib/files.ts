// Shared upload constraints for blood-test file attachments. Kept in one place so
// the client (the file <input> accept list, pre-upload size check, error copy)
// and the server (the authoritative validation in the upload route) can't drift.

/** Max upload size for a single attachment: 10 MB. Lab-result PDFs/scans are
 * small; storing bytes inline in Postgres, this cap keeps rows sane. */
export const MAX_BLOOD_FILE_BYTES = 10 * 1024 * 1024;

/** Accepted content types — lab results are PDFs or image scans/photos. */
export const ALLOWED_BLOOD_FILE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** `accept` attribute for the file <input>, derived from the allow-list. */
export const BLOOD_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp";

/** Human-readable label for the allowed types, used in help/error text. */
export const ALLOWED_BLOOD_FILE_LABEL = "PDF, JPEG, PNG or WebP";

/** Compact human-readable file size, e.g. "184 KB" / "1.4 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
