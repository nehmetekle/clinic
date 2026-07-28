# NutriClinic — Project Handoff (read this first)

Clinic management web app for a nutrition / dietitian practice. Built in 4 versions.
**This file is the continue-here brief for a new chat.** Deeper detail lives in [`docs/`](docs/) and [`README.md`](README.md).

## Where we are
- **Version 1 — Frontend clickable demo** ✅ done
- **Version 2 — Backend + database** ✅ done (and code cleaned: no unused files/exports)
- **Version 3 — Real authentication + permissions** ✅ done — real login (email + password, Argon2id via `@node-rs/argon2`), server-side DB-backed sessions (httpOnly cookie, `Session` model, 30-min inactivity timeout, 7-day absolute TTL), login lockout after 5 failed attempts, and the DB moved off SQLite to Postgres. RBAC (`src/server/auth.ts`) now derives identity from the verified session instead of client-supplied headers.
- **Version 4 — Full data export, printable/PDF receipts, file upload, reminders** — later

## Run it
```bash
npm install
# Local dev: any Postgres works. A throwaway one:
docker run -d --name nutriclinic-postgres -e POSTGRES_USER=nutriclinic \
  -e POSTGRES_PASSWORD=nutriclinic_dev_pw -e POSTGRES_DB=nutriclinic \
  -p 5433:5432 postgres:16-alpine
npx prisma migrate dev      # applies migrations to DATABASE_URL (see .env.example)
npm run db:create-admin     # creates ONE admin from ADMIN_EMAIL/ADMIN_PASSWORD in .env
npm run dev                 # http://localhost:3000
```
Log in with whatever `ADMIN_EMAIL`/`ADMIN_PASSWORD` you set in `.env`. `db:create-admin`
touches nothing but that one `User` row — no demo clients/payments/etc — and is
safe to re-run any time (upserts by email; also clears a lockout, so it doubles
as a password-recovery path if you're ever locked out).

Other scripts: `npm run db:studio` (browse data), `npm run db:reset` (wipes
everything back to empty — there is no seed data to reload), `npm run build`.
Production: point `DATABASE_URL`/`DIRECT_URL` at a Neon Postgres project (see
`.env.example`), run `npx prisma migrate deploy`, then `npm run db:create-admin`.

**There is no seed/demo data.** `prisma/seed.ts` was deleted on purpose — the
only user in this database is ever the one `db:create-admin` creates from
`.env`. Don't reintroduce a seed script/fixtures without being asked.

## Stack & layout
Next.js 15 (App Router) · TypeScript · Tailwind · Recharts · lucide-react · Prisma + **Postgres** (Neon in production) · Zod · `@node-rs/argon2` for password hashing.

```
prisma/            schema.prisma (models), create-admin.ts, migrations/
src/app/api/       REST route handlers (thin: validate → repo/service)
src/app/(app)/     authenticated pages (sidebar shell)
src/server/        db.ts · serialize.ts (mappers) · repositories/* · services/* · http.ts
src/lib/           api.ts (typed client) · use-api.ts (hook) · validation.ts (zod)
                   session.tsx (session context, backed by /api/auth/me) · types.ts · config.ts · nav.ts · utils.ts · toast.tsx
src/components/    ui/ · layout/ · charts/
```
Data flow: pages → `lib/api.ts` → `/api/*` route → `server/repositories|services` → Prisma → Postgres.
Business rules live in the server layer (auto BMI, receipt numbers, visit numbering, session decrement on completed consultation).

## Version 3 — how auth actually works now
Server-side RBAC (`src/server/auth.ts` — `canViewClinical` / `canHandleMoney` /
`canVoidDebt` / `canTrackSamples`, plus `actingRole`/`actingUser`) is unchanged in
shape but now **async**, resolving identity from a verified session instead of a
client-supplied header:
- `POST /api/auth/login` verifies email+password (Argon2id, `src/server/password.ts`),
  creates a `Session` row (`src/server/session.ts` — opaque token, only its
  SHA-256 hash is stored), and sets an httpOnly/SameSite=Lax cookie. 5 failed
  attempts locks the account for 15 min (`User.failedLoginAttempts`/`lockedUntil`).
- `POST /api/auth/logout` revokes the session server-side (not just a client
  cookie clear); `GET /api/auth/me` resolves the current session for the client
  context (`src/lib/session.tsx`).
- `src/app/(app)/layout.tsx` is a Server Component that redirects to `/login` if
  `getServerUser()` finds no valid session — the authoritative page-level gate.
  `middleware.ts` only does Edge-safe checks (cookie *presence* for a fast
  redirect, and a CSRF marker header — `x-nutriclinic-fetch` — on mutating
  `/api/*` calls); it never validates a session itself (Prisma doesn't run on Edge).
- `src/lib/api.ts` no longer attaches any identity headers — the session cookie
  rides along automatically on same-origin `fetch`.

### Hardening pass (post-launch security review)
- **HTTP security headers** (`next.config.mjs`): CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS in production.
- **Admin-initiated password reset**: Staff page → "Reset password" → `PATCH
  /api/staff/[id]/password` (admin only) hashes the new password and calls
  `revokeAllSessionsForUser` so a stolen/left-open session can't outlive the reset.
  This is the *only* password-recovery path **by design** — no self-service
  "forgot password" email flow is planned (see docs/known-issues.md).
- **2FA (TOTP), admin role**: Settings → "Two-factor authentication". Setup is
  request-secret → scan QR → confirm a live code (`src/server/totp.ts`,
  `otplib` + `qrcode`, both pure JS/no native bindings). Confirming mints 8
  one-time backup codes (shown once; only their SHA-256 hashes are stored).
  Login becomes two steps for a 2FA-enrolled account: `POST /api/auth/login`
  returns `{requires2FA, pendingToken}` instead of a session (a `PendingTwoFactor`
  row — same hashed-token pattern as `Session`, 5-min TTL, capped at 5 attempts);
  `POST /api/auth/verify-2fa` exchanges a valid TOTP or backup code for the real
  session. Disabling 2FA requires re-entering the current password.

Not done (deliberately out of scope for now): IP-based/distributed rate limiting
(per-account lockout only — see `src/server/session.ts`'s `MAX_FAILED_LOGIN_ATTEMPTS`).
Password recovery being admin-only (no forgot-password email flow) is a permanent
product decision, not a deferred item — see docs/known-issues.md. The role
permission matrix is in [docs/01-product-spec.md](docs/01-product-spec.md); other
known gaps are in [docs/known-issues.md](docs/known-issues.md).

## Known deferred items (intentional, labeled in UI — pick up in V4)
_Done since this list was written (removed): audit-log-on-write, queue status-transition
persistence, the dietitian-dashboard placeholders, and the new-client wizard's payment/
appointment steps (wizard was reworked to a plain registration form). The old "payment →
package `paymentStatus` recompute" is superseded by the `SessionPlan` per-session billing +
`ClientDebt` clearance systems (see [docs/known-issues.md](docs/known-issues.md))._

_Also done since (removed): **per-referrer commission**. Each `Referrer` now has
an admin-set `fee` (USD, Settings → Referrers); it's frozen onto the patient
(`Client.referralFee`) at the registration moment — `createClient`, which both the
new-client form and a phone booking go through — a one-time cost that reduces
net profit and gross margin, surfaced as the "Referrer cost" card + drill-down on
the dashboard/reports. Freeze-at-use, admin-only, redacted for other roles — see
[docs/known-issues.md](docs/known-issues.md) §8._

_Also done since (removed): the **Food List (Nutrient-Rich Foods List)** — a
collapsible card in the consultation editor between "Consultation notes" and
"Visit services" that reproduces Layaka's paper form, saves with the rest of the
visit, and generates a PDF replica attached to the consultation. See "Food List"
below and [docs/known-issues.md](docs/known-issues.md) §9._

Still open:
- **Full data export** — per-report CSV export works ([reports/page.tsx](src/app/(app)/reports/page.tsx)), but "Export all data (CSV)" in Settings is still a stub.
- **Printable / PDF receipts** — receipt numbers are generated; a printable/PDF receipt is not. (The Food List PDF below is the first use of the PDF pipeline — reuse `src/server/pdf/`.)
- **File upload/download** — the client-profile "Upload" is a stub. (Download works: blood-test results and the generated Food List PDF both appear on the Files tab.)
- **Reminders** — no scheduler/cron; appointment status catch-up runs lazily on read.
- **Open bugs / edge cases** — tracked in [docs/known-issues.md](docs/known-issues.md) (double-booking, phone/email dedup, name-based stats, per-year receipt numbering, …).

## Food List (Nutrient-Rich Foods List)
A web + PDF reproduction of Layaka's paper intake form, used to record what a
patient actually eats.
- **Catalog** — [`src/lib/food-list.ts`](src/lib/food-list.ts) is the single source
  of truth: 8 categories, 94 items, stable ids (`"vegetables.artichoke"`), plus
  the printed column each category sits in. The editor card and the PDF renderer
  both read it, so they can't drift. Labels are verbatim from the paper form —
  don't "tidy" the inconsistent capitalisation.
- **Storage** — `ConsultationFoodList` (1–1 with `Consultation`, optional) holds
  `patientName`, `notes`, `selections` (JSON array of catalog ids) and `language`.
  Saved as part of the normal consultation payload (`foodList` on
  `createConsultationSchema`); **omitting it leaves a saved form untouched**, which
  is what keeps an untouched card from wiping one. Unknown ids are dropped rather
  than failing the save.
- **PDF** — [`src/server/pdf/food-list-pdf.ts`](src/server/pdf/food-list-pdf.ts)
  draws the page with `pdf-lib` (pure JS; Vercel has no headless browser). Fonts
  and Layaka artwork live in `src/server/pdf/{fonts,assets}` and are read from
  disk, so they're listed in `outputFileTracingIncludes` in `next.config.mjs` —
  **if you move them, update that or the route 500s in production only.**
  `POST /api/consultations/[id]/food-list-pdf` renders and attaches it.
- **Attachments** — `ConsultationFile` mirrors `BloodSampleFile` (bytes inline in
  Postgres, `data` never selected for listings). One file per visit per `kind`:
  regenerating replaces. Downloadable by **every** role (unlike lab results); the
  client profile's Files tab is therefore visible to the secretary too, scoped to
  consultation documents only.
- **Arabic** is deliberately out of scope — the picker shows it disabled. The
  `language` column already exists so it needs no migration.
- Fidelity trade-offs vs the Word document (fonts, drawn checkboxes, 4-column
  print vs responsive screen) are written up in
  [docs/known-issues.md](docs/known-issues.md) §9.

## Working conventions (keep these)
- Match existing code style; pages are client components using `useApi`; create forms POST then `refetch()`.
- Validate writes with Zod in `src/lib/validation.ts`; keep route handlers thin.
- Postgres everywhere (dev and prod) via `DATABASE_URL`/`DIRECT_URL` in `.env` — see `.env.example`. Prod points these at Neon.
- After changes: `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` and `npm run build` should both pass.
- Login: `npm run db:create-admin` (see "Run it" above) for the one real admin account — there is no role switcher any more, that was a spoofable dev shortcut removed as part of V3. There is no seed data; don't add any.
