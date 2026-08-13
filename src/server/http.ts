import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { FxError, StaleFxRateError } from "@/lib/money";
import { SuspiciousRateError } from "./repositories/settings";

/** Thrown by the server layer for expected, client-correctable conflicts (e.g. duplicates). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Not allowed") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Thrown when a client is created with a phone that already exists AND the caller
 * hasn't confirmed the duplicate. Warn-don't-block: it carries the matching
 * patient(s) so the form can show "already a client" and let staff proceed anyway
 * (or jump to the existing profile). Serialized with `code: "duplicate_phone"` so
 * the typed client can distinguish it from an ordinary conflict.
 */
export class DuplicatePhoneError extends Error {
  matches: unknown[];
  constructor(matches: unknown[]) {
    super("A patient with this phone number already exists.");
    this.name = "DuplicatePhoneError";
    this.matches = matches;
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });

/** Parses and validates a JSON request body, throwing ZodError on failure. */
export async function readJson<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  const body = await req.json().catch(() => ({}));
  return schema.parse(body);
}

/**
 * Pulls the human-readable message out of a database guard trigger.
 *
 * Some invariants are too important to leave to application code and are
 * enforced by a Postgres trigger instead (today: the Jessy receivable ledger —
 * see the protect_jessy_ledger migration). A trigger's `RAISE EXCEPTION` reaches
 * us as a `PrismaClientUnknownRequestError` whose message buries the real text
 * inside a Rust debug dump. Rather than let that surface as a 500 with an
 * unreadable body, we extract the message the trigger actually wrote — those are
 * authored as user-facing sentences — and report it as an ordinary conflict.
 *
 * Returns null for anything that isn't a trigger-raised error (SQLSTATE P0001).
 */
function databaseGuardMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const match = /code: "P0001", message: "((?:[^"\\]|\\.)*)"/.exec(err.message);
  if (!match) return null;
  // Un-escape the quoted debug string (\" and \\ are the only escapes emitted).
  return match[1].replace(/\\(.)/g, "$1");
}

/** Converts thrown errors into consistent JSON responses. */
export function handleError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return json({ error: "Validation failed", details: err.flatten() }, 400);
  }
  const guarded = databaseGuardMessage(err);
  if (guarded) {
    // A protected-record violation is a client-correctable conflict, not a bug.
    console.error(err);
    return json({ error: guarded }, 409);
  }
  if (err instanceof DuplicatePhoneError) {
    return json({ error: err.message, code: "duplicate_phone", matches: err.matches }, 409);
  }
  if (err instanceof ConflictError) {
    return json({ error: err.message }, 409);
  }
  // A rate change big enough to look like a typo. 409 with a machine-readable
  // code + the detected jumps, so the Pricing page can offer an explicit
  // confirmation instead of the admin re-typing blind. Nothing was written.
  if (err instanceof SuspiciousRateError) {
    return json(
      {
        error: err.message,
        code: "fx_rate_confirmation_required",
        suspicions: err.suspicions,
      },
      409,
    );
  }
  // The admin moved a rate between the settlement screen being prepared and
  // submitted. Nothing was written. Typed so the desk sees "the rate changed,
  // review and resubmit" rather than an arithmetic error it cannot act on.
  if (err instanceof StaleFxRateError) {
    return json({ error: err.message, code: "fx_rate_stale", rates: err.rates, detail: err.detail }, 409);
  }
  // An amount that cannot be converted safely (missing/absurd rate, unsupported
  // currency). Client-correctable — the desk fixes the rate in Pricing — so it is
  // a 409 carrying the real reason, never a silent 1:1 conversion and never a 500.
  if (err instanceof FxError) {
    console.error(err);
    return json({ error: err.message }, 409);
  }
  if (err instanceof ForbiddenError) {
    return json({ error: err.message }, 403);
  }
  if (err instanceof NotFoundError) {
    return json({ error: err.message }, 404);
  }
  console.error(err);
  return json({ error: "Internal server error" }, 500);
}
