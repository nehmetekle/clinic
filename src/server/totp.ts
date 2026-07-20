import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { randomBytes, createHash } from "crypto";

const ISSUER = "NutriClinic";
const BACKUP_CODE_COUNT = 8;
// No 0/O/1/I — avoids transcription mistakes when a user copies a code by hand.
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTotpSecret(): string {
  return generateSecret();
}

export async function buildQrCodeDataUrl(email: string, secret: string): Promise<string> {
  const uri = generateURI({ issuer: ISSUER, label: email, secret });
  return QRCode.toDataURL(uri);
}

export async function verifyTotpCode(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  // epochTolerance: 30 = accept one 30s step of clock drift either side.
  const result = await verify({ secret, token, epochTolerance: 30 });
  return result.valid;
}

function generateBackupCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const b of bytes) code += BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5, 10)}`;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().trim()).digest("hex");
}

/** A fresh set of backup codes: plaintext (shown to the user exactly once) and
 * their hashes (the only form ever persisted). */
export function generateBackupCodes(): { plaintext: string[]; hashes: string[] } {
  const plaintext = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  return { plaintext, hashes: plaintext.map(hashBackupCode) };
}

/** Checks a candidate against stored hashes; returns the remaining hash list
 * with the match removed (single-use) or null if the candidate doesn't match
 * any of them. */
export function consumeBackupCode(storedHashes: string[], candidate: string): string[] | null {
  const hash = hashBackupCode(candidate);
  const idx = storedHashes.indexOf(hash);
  if (idx === -1) return null;
  return [...storedHashes.slice(0, idx), ...storedHashes.slice(idx + 1)];
}
