import {
  createBloodSampleFile,
  listBloodSampleFiles,
} from "@/server/repositories/bloodSampleFiles";
import { actingUser, canAttachSampleFile } from "@/server/auth";
import { handleError, json } from "@/server/http";
import {
  ALLOWED_BLOOD_FILE_LABEL,
  ALLOWED_BLOOD_FILE_TYPES,
  MAX_BLOOD_FILE_BYTES,
} from "@/lib/files";

// Bytes are stored inline in Postgres, so this route runs on the Node runtime
// (Buffer, no Edge). Attachments are small and size-capped below.

/**
 * List a blood test's attached files (metadata only). Visible to anyone who may
 * attach a file — the secretary needs to see a result was uploaded so she doesn't
 * chase it again, even though downloading the content is doctor/admin-only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canAttachSampleFile(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    return json(await listBloodSampleFiles(id));
  } catch (e) {
    return handleError(e);
  }
}

const ALLOWED = new Set<string>(ALLOWED_BLOOD_FILE_TYPES);

/**
 * Upload a lab-result file and attach it to this blood test. Multipart form with a
 * single `file` field. Type and size are validated server-side (the UI mirrors the
 * same limits but the server is the guard). Secretary, doctor and admin may upload.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canAttachSampleFile(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return json({ error: "No file provided" }, 400);
    }
    if (!ALLOWED.has(file.type)) {
      return json({ error: `Unsupported file type — use ${ALLOWED_BLOOD_FILE_LABEL}.` }, 400);
    }
    if (file.size === 0) {
      return json({ error: "File is empty." }, 400);
    }
    if (file.size > MAX_BLOOD_FILE_BYTES) {
      return json({ error: "File is too large (max 10 MB)." }, 400);
    }

    // Take the basename only and strip anything but a safe set — the stored name is
    // echoed back in Content-Disposition on download, so it must never smuggle path
    // separators or control characters.
    const rawName = file.name.split(/[\\/]/).pop() ?? "file";
    const filename = rawName.replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "file";

    const data = Buffer.from(await file.arrayBuffer());
    const actor = await actingUser(req);
    const created = await createBloodSampleFile(
      { bloodSampleId: id, filename, mimeType: file.type, data },
      { name: actor.name, email: actor.email },
    );
    return json(created, 201);
  } catch (e) {
    return handleError(e);
  }
}
