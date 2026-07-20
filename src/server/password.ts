import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id profile (one of the profiles OWASP's password
// storage cheat sheet lists as acceptable). Params are embedded in the encoded
// hash string alongside a random salt, so verify() doesn't need them repeated.
// `algorithm: 2` is `Algorithm.Argon2id` — the numeric literal is used
// directly because it's an ambient `const enum`, which `isolatedModules`
// (enabled in this project) disallows importing across module boundaries.
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

// Computed once and reused for login attempts against an unknown identifier,
// so verifying a nonexistent user's "password" costs the same as a real one —
// a login response's timing never reveals whether the account exists.
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("not-a-real-password-used-only-for-timing");
  return dummyHashPromise;
}
