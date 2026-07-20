import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

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

/** Converts thrown errors into consistent JSON responses. */
export function handleError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return json({ error: "Validation failed", details: err.flatten() }, 400);
  }
  if (err instanceof DuplicatePhoneError) {
    return json({ error: err.message, code: "duplicate_phone", matches: err.matches }, 409);
  }
  if (err instanceof ConflictError) {
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
