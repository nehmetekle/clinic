# NutriClinic — Project Handoff (read this first)

Clinic management web app for a nutrition / dietitian practice. Built in 4 versions.
**This file is the continue-here brief for a new chat.** Deeper detail lives in [`docs/`](docs/) and [`README.md`](README.md).

## Where we are
- **Version 1 — Frontend clickable demo** ✅ done
- **Version 2 — Backend + database** ✅ done (and code cleaned: no unused files/exports)
- **Version 3 — Real authentication + permissions** ✅ done — real login (email + password, Argon2id via `@node-rs/argon2`), server-side DB-backed sessions (httpOnly cookie, `Session` model, **31-day absolute TTL, no inactivity timeout** — see "Session lifetime" below), login lockout after 5 failed attempts, and the DB moved off SQLite to Postgres. RBAC (`src/server/auth.ts`) now derives identity from the verified session instead of client-supplied headers.
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

### Session lifetime — 31 days, activity-independent
**There is no inactivity timeout. Don't reintroduce one.** A session is valid for
a fixed **31 days from login** (`ABSOLUTE_TTL_MS` in `src/server/session.ts`),
whether the user works in it constantly or never touches it.
- The deadline is frozen at creation onto `Session.expiresAt` **and** onto the
  cookie's `maxAge`, both from the same constant — so it can't slide, and
  restarts/redeploys/navigation/idle time can't shorten it. It lives in Postgres
  and the client's cookie, never in server memory.
- `Session.lastUsedAt` is **informational only** now ("when was this last
  seen"). It no longer gates validity; the throttled write just keeps a DB
  update off every request. Don't wire it back into an expiry check.
- **Why**: the old 30-min idle timeout (docs/01-product-spec.md §3.1) assumed a
  browser on a shared desk. The clinic runs the Electron kiosk fullscreen on
  staff PCs where nothing pings the server between patients, so it fired several
  times a day. The kiosk shell is not involved — it persists cookies correctly
  in `%APPDATA%\Layaka` via `session.defaultSession`.
- **Ending a session early is always an explicit act**: logout
  (`revokeSessionByToken`), admin password reset or account deactivation
  (`revokeAllSessionsForUser`, from `repositories/staff.ts`), account deletion
  (`Session` cascades on `User`), or an admin revocation.
- **Deactivation is immediate and doesn't rely on that revocation sweep** —
  `resolveSessionToken` re-reads `user.status` on every single resolve and
  refuses anything not `active`. The sweep runs too; it makes the tokens dead
  rather than merely rejected, so nothing revives on re-activation.

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
package `paymentStatus` recompute" is superseded by the `SessionPlan` upfront billing +
`ClientDebt` clearance systems (see "Session plans, bundles & billing" below)._

_Also done since (removed): **per-referrer commission**. Each `Referrer` now has
an admin-set `fee` (USD, Settings → Referrers); it's frozen onto the patient
(`Client.referralFee`) at the registration moment — `createClient`, which both the
new-client form and a phone booking go through — a one-time cost that reduces
net profit and gross margin, surfaced as the "Referrer cost" card + drill-down on
the dashboard/reports. Freeze-at-use, admin-only, redacted for other roles — see
[docs/known-issues.md](docs/known-issues.md) §8._

_Also done since (removed): **Jessy, the third-party payer**. `jessy` is a normal
payment method (works everywhere the others do, splits included), but a patient
paying through it recognizes the income **immediately** while raising a separate
`JessyReceivable` for what Jessy owes the clinic. A later transfer from Jessy
clears that receivable and creates **no income** (it was already counted). Admin
`/jessy` page + "Outstanding from Jessy" on Reports. See "Jessy" below and
[docs/known-issues.md](docs/known-issues.md) §14._

_Also done since (removed): the **Food List (Nutrient-Rich Foods List)** — a
collapsible card in the consultation editor between "Consultation notes" and
"Visit services" that reproduces Layaka's paper form, saves with the rest of the
visit, and generates a PDF replica attached to the consultation. See "Food List"
below and [docs/known-issues.md](docs/known-issues.md) §9._

Still open:
- **Full data export** — per-report CSV export works ([reports/page.tsx](src/app/(app)/reports/page.tsx)), but "Export all data (CSV)" in Settings is still a stub.
- **Printable / PDF receipts** — receipt numbers are generated; a printable/PDF receipt is not. (The Food List PDF below is the first use of the PDF pipeline — reuse `src/server/pdf/`.)
- **File upload/download** — the client-profile "Upload" is a stub. (Download works: blood-test results and the generated Food List PDF both appear on the Files tab.)
- **Reminders** — appointment status catch-up still runs lazily on read (no cron
  for that). WhatsApp appointment reminders, however, **are** implemented:
  `src/server/reminders.ts` + `POST /api/cron/reminders` (24h and ~1h, each sent
  once, tracked by the `reminderNNSentAt` columns). Rescheduling nulls both
  stamps so a moved patient is reminded about the new slot — see
  [docs/known-issues.md](docs/known-issues.md) §12.
- **Open bugs / edge cases** — tracked in [docs/known-issues.md](docs/known-issues.md) (phone/email dedup, name-based stats, per-year receipt numbering, …).

## Sessions, bundles & billing — settle before use
The rule, in the words the front desk uses:

> **Purchase sessions → settle by payment or debt → sessions become usable →
> machine visits only consume them.**

**`SessionPlan`** — one plan per patient per machine.

| column | meaning |
| --- | --- |
| `sessionsNeeded` | the **prescribed course length** (clinical intent). Bills nothing by itself. |
| `sessionsPaid` | sessions **purchased AND settled** — the usable supply. |
| `sessionsUsed` | sessions delivered. |
| `available` | `sessionsPaid − sessionsUsed`, floored at 0. Derived. |

- **Settling is the unlock.** A basket is settled either by being paid or by its
  balance being moved to a `ClientDebt` — **both unlock identically**. A *pending*
  basket unlocks nothing. `creditSessionPlanPaidTx` runs after the conditional
  `pending → paid` flip, so a double submit unlocks exactly once.
- **The unpaid money lives in exactly one place: the `ClientDebt`.** The plan
  carries no balance owed. This is why session-plan lines may now be deferred to a
  debt (the old "non-plan portion only" cap is gone) — there is nothing left to
  double-count.
- **Two purchase routes, never double-billed**: the consultation that prescribes
  the course, and the standalone front-desk sale (`sellSessions`, Client →
  Treatments → **Sell sessions**; settled from Client → Payments → **To settle**,
  which is date-free — the queue's Payment lane only carries today's baskets).
  Billable = `sessionsNeeded − sessionsPaid −
  pendingOnOtherBaskets`; `pendingPurchasedSessionsTx` supplies that last term.
  **Never write that exclusion as a Prisma `{ not: id }` filter** — it compiles to
  SQL `<>`, which is NULL for a standalone sale basket and drops exactly the rows
  it must find (a real double-billing bug; see docs/known-issues.md §18).
- **A plan line still can't be retyped, repriced, dropped or invented at
  checkout** — its settled quantity is what unlocks sessions. The settlement modal
  locks the field *and* `updateVisitBasket` refuses the change, so a direct PATCH
  can't bypass it. Deferring the money to a debt is fine; that changes what is
  collected, not what was sold.
- **One ACTIVE plan per client per machine, enforced by the database** —
  `SessionPlan.activeMachineKey` mirrors `machine` only while the plan is active
  (null otherwise) under `@@unique([clientId, activeMachineKey])`. Always set it
  through `activeMachineKey()` in `repositories/sessionPlans.ts`. Both
  `createSessionPlan` and `sellSessions` **reuse** the active plan.
- **The one exception — the originating consultation.** The visit that prescribes
  a course may also deliver from it before the patient reaches the desk
  (`limit: "prescribed"`, drawing against `sessionsNeeded`). Safe because
  `assertBasketSettledTx` won't let a visit close with an unsettled basket. Machine
  visits get `limit: "available"` and no exception.
- **`sessionsNeeded` is reconciled on every edit/delete** —
  `reconcileSessionPlanNeedsTx`, floored by `sessionPlanNeedsFloorTx` (bought +
  pending + delivered), so a prescribed course can never drop below what was sold
  or delivered.
- CHECK: `sessionsPaid <= sessionsNeeded AND sessionsUsed <= sessionsNeeded`
  (`20260813200000_sessions_settle_before_use`) — hand-written SQL Prisma can't
  introspect, don't lose it in a squash.

**Bundles (`Package` → `ClientPackage`)** are unchanged and independent: a fixed
quantity at a **fixed price**, never `sessions × per-session rate`. Applying a
15-session/$140 bundle bills **$140** on that visit (net of the bundle's own
`discountPercent`) and credits 15 sessions; today's session comes out of that
balance, leaving 14. Only sessions used beyond the balance fall back to the
per-session catalog price. Bundles can be started on the visit's first save only.

**No refunds.** Money, once collected, is never reversed: a visit with a settled
basket cannot be deleted (and there is no refund/void flow anywhere — don't build
one). Deleting is only for a mistaken visit that has collected nothing; it reverses
that visit's usage, restores the sessions it consumed, trims any unsold course
length it added, and drops a plan it alone created.

The editor's live basket preview mirrors the server's billing kernel line for line
(`treatmentBillable` in `consultations/new/page.tsx` ↔ `sessionBillable` +
`allocateCoverage` in `repositories/consultations.ts`), so the price the dietitian
previews and the amount charged can't drift. Regression coverage:
[tests/race/t13-billing-rules.ts](tests/race/t13-billing-rules.ts) and
[tests/race/t21-sessions-settle-before-use.ts](tests/race/t21-sessions-settle-before-use.ts)
(`npm run test:race`). Full detail in [docs/known-issues.md](docs/known-issues.md) §18.

## Machine visits (machine-only attendance)
A patient who comes in **only** to use prepaid machine sessions is recorded as a
`MachineVisit` + `MachineVisitItem` — a real visit in history that is **not** a
consultation. No visit number, no measurements/notes/goals, no Food List, no
consultation fee, no close flow. Logged from the client profile (**Treatments**
tab — renamed from "Bundles" — either a row's "Log visit" or the card's "Log
machine visit") or from the queue board ("Machine visit" on a checked-in/with-doctor
card, which carries the appointment id along).
- **Permission**: `canLogMachineVisit` (`src/server/auth.ts`) = **dietitian +
  admin**. Deciding a consultation isn't needed is the clinical side's call.
  Selling the sessions is the front desk's — `canSellSessions` (secretary + admin).
- **It never bills.** A machine visit consumes `available` sessions and raises no
  basket, no charge and no debt. Short of availability it is **refused** ("N
  sessions available — sell and settle more sessions first"), never billed. Bundles
  work the same way; over-consuming one is refused, not clamped.
- **Void, don't edit** — the row stays in history with actor/time/reason and
  sessions come back exactly. A **settled** machine visit can't be voided (there is
  no refund path in this app, by design); that guard now only ever fires on
  historic rows, since current visits raise no basket at all.
- **Appointments**: an explicit id from the queue is completed (after an ownership
  check); with no id, only a single unambiguous live appointment is auto-completed.
  **Consultations now follow the same rule** via `Consultation.appointmentId` —
  closing a visit completes the booking it was started from and no other (it used
  to complete every live appointment the patient had).
- **Reporting**: counts as attendance and machine usage, never as a consultation —
  `counts.machineVisits` and a separate `machineVisits` column in staff activity
  sit alongside (never inside) the consultation figures. "Machine utilization" on
  Reports shows sessions per machine with the machine-visit vs consultation split;
  consultation sessions count from **closed** visits only (open drafts still
  consume balances — it's a reporting rule, not an accounting one).
- **Session counters are now one implementation** for both paths:
  `src/server/repositories/sessionCounters.ts` — guarded single-statement SQL
  updates (no read-then-write), no silent clamping, plus CHECK constraints on the
  counters. `updateConsultation`/`deleteConsultation` also take the visit's row
  lock, which fixed a real pre-existing double-count on concurrent draft saves.
- Tests: `tests/race/t19-machine-visits.ts`. Full detail in
  [docs/known-issues.md](docs/known-issues.md) §17 and §18.

## Rescheduling an appointment
`PATCH /api/appointments/[id]/reschedule` moves a booking in place (date/time/
doctor/visit type; status stays `scheduled`), kept separate from the status
endpoint. **Secretary/admin only** — enforced by `canManageAppointments`, not
just hidden. Offered on the client profile, Appointments & history, and the queue
board (including the otherwise read-only other-day board). `isReschedulable` in
`components/ScheduleAppointmentModal.tsx` is the single eligibility predicate
shared by every surface and mirrors the server guard. **A client can't be
double-booked at the same date/time** — assigned or not, and even split across
two different dietitians — enforced in Postgres via `Appointment.activeSlotKey`
(a `clientId|date|time` mirror, unique while the booking is ACTIVE; see
`activeSlotKey()` in `src/server/repositories/appointments.ts`). This does
**not** stop two *different* clients being booked into the same
dietitian/date/time — it's a one-client-one-slot guarantee, not doctor-capacity
enforcement; see [docs/known-issues.md](docs/known-issues.md) §12 ("Appointment
slot uniqueness") for detail.

## Jessy (third-party payer)
A prepaid/third-party payer: the patient settles through Jessy, Jessy transfers
the money to the clinic later.
- **It is a normal payment method.** `jessy` lives in `PAYMENT_METHOD_VALUES`
  ([src/lib/types.ts](src/lib/types.ts)) alongside cash/card/whish/omt, so every
  dropdown, Zod schema, split settlement and method breakdown picks it up for
  free. It gets **no card surcharge** — that stays `card`-only.
- **Income is recognized at once, not when Jessy pays.** A $600 visit paid $400
  through Jessy leaves: a $400 `jessy` Payment (counted in income today), a $200
  normal `ClientDebt`, and a $400 `JessyReceivable`. The patient never owes the
  Jessy portion. **`ClientDebt` is unchanged** — patient debt stays independent
  of payment method.
- **The receivable is created inside `createPayment`** — the one chokepoint every
  Payment goes through — as a **nested Prisma create**, so payment + receivable
  are one atomic statement on every path (manual, basket settlement, debt clear).
  The ledger is USD, converted at the rate frozen on its own payment.
- **A settlement is a collection, never income.** `recordJessySettlement`
  ([src/server/repositories/jessy.ts](src/server/repositories/jessy.ts)) applies
  money received from Jessy oldest-first (FIFO) across receivables, writing no
  Payment. Partial settlements supported; over-settlement refused; each transfer
  keeps per-receivable allocations so history is auditable to the visit.
- **Concurrency is DB-enforced, not UI-enforced**: guarded `remaining >= portion`
  decrements, a unique `paymentId` (one receivable per payment, so a double
  submit can't stack), an idempotency key on settlements, and Postgres CHECK
  constraints (`remaining BETWEEN 0 AND amount`) as the last line of defence.
- **The ledger is protected by database triggers** (`protect_jessy_ledger`): you
  cannot delete a receivable Jessy has settled against (this also blocks deleting
  its `Payment` or cascading a `Client` delete into it), raise a `remaining`,
  edit a frozen `amount`, or touch a settlement or its allocations. `handleError`
  turns a blocked write into a **409 carrying the trigger's own message**, never
  a 500. Unsettled receivables still delete freely with their payment.
- **Those CHECKs and triggers are hand-written SQL — Prisma can't express or
  introspect them, so don't lose them if migrations are ever squashed.**
  `TRUNCATE` bypasses row triggers and is the sanctioned ledger reset for tests
  (`resetJessyLedger()` in `tests/race/harness.ts`).
- **Admin-only, both sides** — `canManageJessy` in `src/server/auth.ts` gates the
  page, `GET /api/jessy` and `POST /api/jessy/settlements`. Stricter than
  `canHandleMoney` on purpose: the ledger is a financial report, which
  docs/01-product-spec.md §2.1 reserves for the admin, and recording a transfer
  means reconciling against a balance the secretary may not see.
- **Keep the three figures separate**: Jessy income volume (already income) ≠
  Jessy outstanding (a balance, never windowed, never income) ≠ settlements
  received (a collection). `recorded − settled === outstanding` is asserted in
  the tests.
- **There is deliberately no void/reversal** — the clinic doesn't refund, and the
  app has no payment-void concept at all. Read
  [docs/known-issues.md](docs/known-issues.md) §14 before adding one.
- Tests: `tests/race/t14-jessy.ts` via `npm run test:race`.

## Food List (Nutrient-Rich Foods List)
A web + PDF reproduction of Layaka's paper intake form, used to record what a
patient actually eats.
- **Catalog** — [`src/lib/food-list.ts`](src/lib/food-list.ts) is the single source
  of truth: 8 categories, 107 items, stable ids (`"vegetables.artichoke"`), plus
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
  Postgres, `data` never selected for listings). One file per visit per `kind`,
  enforced by a DB unique constraint on `(consultationId, kind)` —
  `saveConsultationFile` upserts against it, so regenerating replaces the row in
  place (stable id, refreshed `createdAt`) and two generators racing can't stack
  copies. See [docs/known-issues.md](docs/known-issues.md) §13. Downloadable by **every** role (unlike lab results); the
  client profile's Files tab is therefore visible to the secretary too, scoped to
  consultation documents only.
- **Generated automatically on close.** `ensureFoodListPdf`
  (`src/server/services/foodListPdf.ts`) runs after a visit closes, from both
  close paths, so a doctor who filled the form in but never pressed "Generate
  PDF" still leaves a sendable file behind (a closed visit is read-only — there's
  no going back). Also re-renders if the form was edited after the last PDF.
  No-ops when no form exists or nothing is ticked; **never throws** — close has
  already committed. Failures are still invisible to the user but are reported as
  a structured `food_list_pdf.failed` line via `src/server/observability.ts`. Runs at the route layer, outside the close transaction.
- **"Print"** (not Download) is the action on a Food List PDF, in the editor's
  card and the client's Files tab, for **all three roles** — the sheet exists to
  be handed to the patient on paper. It opens the PDF in a new tab served
  `Content-Disposition: inline` (`?disposition=inline` on
  `/api/consultation-files/[fileId]`, `api.consultationFilePrintUrl`), where the
  browser's own viewer owns the print dialog; it stays a real link, so "Save as"
  covers anyone who wants the file. Blood-test results still say **Download** —
  they're clinical data, not a printout. Access is unchanged: that route is
  deliberately not clinical-gated, so the secretary prints from the front desk.
- **"Send via WhatsApp"** sits next to Print for a Food List PDF (the
  editor's card and the Files tab), for **all three roles**. It refuses on a PDF
  the form has moved past (`stale` on every file listing, from the shared
  `isFoodListPdfStale`) and asks for a regenerate instead — see
  [docs/known-issues.md](docs/known-issues.md) §13. It downloads the PDF
  and opens a `wa.me` chat on the patient's number with a message pre-typed —
  **it cannot attach the file**, which is a WhatsApp platform restriction with no
  workaround, so the sender attaches it by hand. `whatsAppChatUrl`
  (`src/lib/whatsapp.ts`) refuses to build a link for a phone without a country
  code or with an impossible number rather than guess; the button then shows what
  to fix. See [docs/known-issues.md](docs/known-issues.md) §11 before changing the
  wording or the click handler (both actions must stay in one user gesture).
- **Phone rules live in `src/lib/phone.ts`** (moved out of `components/ui/Field.tsx`,
  which re-exports `isValidPhone`) so the server shares them: patient phones are
  now validated with `isValidInternationalPhone` in `createClientSchema`/
  `updateClientSchema`. Use that one — not `isValidPhone`, which stays lax for the
  input field — anywhere a number actually gets dialled.
- **Both languages are built.** English reproduces "Patient paper english.docx";
  Arabic reproduces "Patient paper 1.docx" — the same 107 items, mirrored
  right-to-left (Vegetables is the rightmost column, checkbox to the right of its
  label, Name/Notes bottom-right). Item ids are **shared**, so selections are
  language-independent: a form ticked in English prints unchanged in Arabic and
  switching language never loses a tick. Both editions share one renderer;
  everything language-specific is in the `LAYOUTS` table in `food-list-pdf.ts`.
- **Arabic text is normalised, not verbatim** — the source .docx stores pre-shaped
  presentation forms with Persian/Urdu letters mixed in. Re-extracting labels from
  that file means re-normalising them. RTL rendering has four non-obvious
  requirements (never reorder characters; don't trust Noto's line metrics; treat
  an unspaced `/` as a break opportunity; and draw Arabic glyphs via
  `drawShaped()` rather than `page.drawText`, because pdf-lib discards the GPOS
  offsets that place every letter's dots — which is also why the Arabic face is
  embedded with `subset: false`) — all explained in
  [docs/known-issues.md](docs/known-issues.md) §10 before you touch that code.
- **After any layout change, the English page must stay pixel-identical** — that's
  the regression test. Fidelity trade-offs vs both Word documents (fonts, drawn
  checkboxes, padding, 4-column print vs responsive screen) are in
  [docs/known-issues.md](docs/known-issues.md) §9 (English) and §10 (Arabic).

## Multi-currency tender (USD / EUR / LBP)
**Obligations are USD. Payments may be tendered in USD, EUR or LBP.** A $1,000
bill stays $1,000 however it is paid; a $400 debt stays a $400 debt even when
settled with €368. Only `Payment` carries a tender currency.
- **Two currency types, on purpose.** `Currency` ([src/lib/types.ts](src/lib/types.ts))
  is the denomination of an *obligation* and stays `"USD" | "LBP"`;
  `TenderCurrency` ([src/lib/money.ts](src/lib/money.ts)) is `"USD" | "EUR" | "LBP"`
  and appears only on payments. **Don't widen `Currency`** — that would put FX
  exposure onto bills and debts, which is out of scope.
- **One rate direction, stated once**: `fxRate` = units of the tender currency
  per 1 USD; USD value = `native / fxRate`. Everything routes through
  `fxRateFor` / `tenderToUsd` so it can't be inverted at a call site.
- **`Payment.fxRate` freezes the rate** at settlement, resolved server-side from
  Settings inside the transaction. Reports read it via `paymentUsd`, never
  today's rate, so changing a rate can't re-price history. A rate is never
  accepted from the client. Legacy rows (`fxRate` null) are USD/LBP and still
  value through their `usdToLbp` snapshot — which is why `usdToLbp` was
  deliberately **not** renamed across its five models.
- **Split legs are `method × currency`**, never method alone — "Cash/USD" and
  "Cash/EUR" are distinct legs, each its own Payment row and receipt.
- **Tolerance**: `0.005 × (1 + non-USD legs)`. A USD-only settlement keeps the
  original exact half-cent epsilon — no regression, no cent-level underpayment.
- **`toUsd` and `asCurrency` now fail closed** (they used to treat any unknown
  currency as USD). Add a currency to the exhaustive switch in `fxRateFor` and
  the compiler will find every site that needs a decision.
- **Jessy stays USD-only** (schema + `createPayment` + UI). Its FIFO ledger is
  only sound in one unit.
- **`ClientDebt.paidAmount`** enables partial collection (needed because foreign
  tender rarely hits the exact balance). Overpayment is refused — there are no
  credit balances, as there are no refunds.
- CHECK constraints in `20260813150000_multi_currency_tender` are hand-written
  SQL Prisma can't introspect — don't lose them in a squash.
- **Stale rate at checkout**: the settlement screen sends `expectedRates`
  (advisory, never used to value anything). If a rate it uses has moved, the
  settlement is rejected with a specific `fx_rate_stale` error and nothing is
  written — never silently re-priced.
- **Suspicious rate changes** need explicit admin confirmation carrying the value
  being confirmed (not a bypass flag). Absolute `FX_BOUNDS` fire first; the
  relative `FX_SUSPICIOUS_RATIO` catches order-of-magnitude typos.
- **`FxRateChange`** is the append-only rate history (admin-only,
  `GET /api/settings/fx-history`), plus an `AuditLog` line. `updateSettings` takes
  a `pg_advisory_xact_lock` so concurrent edits can't record a false "old value".
- **Receipts** (`GET /api/receipts/[paymentId]`) render on demand from frozen
  payment rows — never stored, never read Settings, so a reprint can't re-price.
- **The tolerance is a flat half-cent** and does NOT scale with leg count (the
  earlier per-leg scaling let a full cent through — see §16).
- Tests: `tests/race/t16-multi-currency-tender.ts`,
  `t17-fx-governance-and-receipts.ts`, `t18-adversarial-financial.ts` via
  `npm run test:race`. Full detail in [docs/known-issues.md](docs/known-issues.md)
  §15 and §16.

## Working conventions (keep these)
- Match existing code style; pages are client components using `useApi`; create forms POST then `refetch()`.
- Validate writes with Zod in `src/lib/validation.ts`; keep route handlers thin.
- Postgres everywhere (dev and prod) via `DATABASE_URL`/`DIRECT_URL` in `.env` — see `.env.example`. Prod points these at Neon.
- After changes: `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` and `npm run build` should both pass.
- Concurrency tests for the Food List PDF pipeline: `npm run test:race` (needs a
  `*_test` Postgres database — see [tests/race/README.md](tests/race/README.md)).
- Login: `npm run db:create-admin` (see "Run it" above) for the one real admin account — there is no role switcher any more, that was a spoofable dev shortcut removed as part of V3. There is no seed data; don't add any.
