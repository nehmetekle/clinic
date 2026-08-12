/**
 * Server-side failure reporting.
 *
 * The app has no logging library and doesn't need one: anywhere this runs
 * (Vercel, a container, `next start`) captures the process's stderr, so a
 * structured single line on `console.error` is already a searchable, alertable
 * event. This module exists so those lines have one shape — `event` names the
 * failure, the rest is context — instead of each call site inventing a sentence.
 *
 * Two rules, both load-bearing:
 * - **It never throws.** Its callers are best-effort paths (a Food List PDF that
 *   fails after a visit has already closed); a reporting bug must not turn a
 *   finished action into an error the user sees.
 * - **It never carries clinical content.** Ids and stage names only — no patient
 *   name or phone, no food-list answers, no notes. `redact` scrubs values the
 *   caller knows are sensitive out of the error message, because a message that
 *   quotes a filename ("Food List - Jane Doe - Visit 3.pdf") would otherwise name
 *   the patient in a log line.
 */

/** Context values worth logging: identifiers and flags, never free text. */
export type FailureContext = Record<string, string | number | boolean | null | undefined>;

/** Long messages are truncated — a log line is a signal, not a payload. */
const MAX_MESSAGE = 400;

/**
 * Strips the noise a Prisma error carries — the echoed source lines and absolute
 * build paths — so the part that says what actually went wrong survives
 * truncation. Without this the useful tail (and anything needing redaction) sits
 * past the cut-off, which hides a leak rather than preventing one.
 */
function condense(message: string): string {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\d+\s/.test(line) && !line.startsWith("→"))
    .map((line) => line.replace(/(?:\/[\w.@+-]+)+\/([\w.-]+\.(?:ts|tsx|js|mjs))/g, "$1"))
    .join(" ");
}

function describe(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name || "Error", errorMessage: error.message };
  }
  return { errorName: typeof error, errorMessage: String(error) };
}

function scrub(message: string, redact: readonly (string | null | undefined)[]): string {
  let out = condense(message).replace(/\s+/g, " ").trim();
  for (const value of redact) {
    const v = value?.trim();
    if (!v || v.length < 3) continue; // too short to match meaningfully
    out = out.split(v).join("[redacted]");
  }
  // Belt and braces for identifiers that can reach an error message without the
  // caller naming them (a phone in a validation error, an email in a DB error).
  out = out
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-number]");
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/**
 * Emits one structured error line for a failure worth noticing in production.
 *
 * ```
 * {"level":"error","event":"food_list_pdf.failed","consultationId":"…","stage":"render", …}
 * ```
 * Alert on `event`; the rest is what you need to find the visit again.
 */
export function reportFailure(
  event: string,
  context: FailureContext,
  error: unknown,
  opts: { redact?: readonly (string | null | undefined)[] } = {},
): void {
  try {
    const { errorName, errorMessage } = describe(error);
    console.error(
      JSON.stringify({
        level: "error",
        event,
        at: new Date().toISOString(),
        ...context,
        errorName,
        errorMessage: scrub(errorMessage, opts.redact ?? []),
      }),
    );
  } catch {
    /* Reporting must never be the thing that breaks the request. */
  }
}
