# Known Issues & V3 Readiness

_Last updated: 2026-07-03._

A running checklist so we don't lose track of known-but-unfixed items as the
project grows. Item numbers match the codebase health-check audit. Nothing here
is fixed yet — these are logged on purpose.

Already fixed (for reference, not open): receipt-number collisions (#2), basket
settlement double-charge (#3), missing permission checks (#1), and recurring-cost
history freezing (#4, which also incidentally fixed the currency-switch stale-rate
concern — a currency change now re-snapshots the exchange rate for the new period).

**Per-session billing / `SessionPlan` (implemented, engine only):** pay-as-you-go
clients (NOT on a fixed-price package) now have a `SessionPlan` tracking
`sessionsNeeded / sessionsUsed / sessionsPaid`, with derived credit
(`paid − used`). `sessionsUsed` advances when a visit is logged; `sessionsPaid`
advances only at settlement (by the final settled quantity, inside the same
atomic transaction as the payment). A visit fully covered by prepaid credit
auto-settles at $0 with a recorded basket and no secretary checkout. This is the
per-session realization of the old "Payment → package paymentStatus recompute"
deferral, built as a **separate system** from Packages (fixed-price package logic
is untouched). **Deferred to a follow-up:** the UI (dietitian linking a treatment
to a plan + showing credit, and the client-detail balance view) — the engine is
proven via scripts but not yet wired into any screen, and no demo `SessionPlan`
is seeded until that UI lands.

**Client debt / clearance (Phase 2, implemented):** closing a consultation with a
still-unpaid delta basket now converts the owed amount into a tracked `ClientDebt`
(`source: close_unpaid`) and takes the basket out of the settlement queue
(`status: cleared_with_debt`) instead of leaving money uncollected. Session-plan
charged lines are **not** duplicated as a debt — the plan's own
`sessionsUsed > sessionsPaid` gap already tracks them (the agreed rule), so only
one-off (non-plan) charges become a debt. The secretary can also record a
still-owed remainder at settlement (`source: secretary_override`). Debts show on
the client profile (Payments tab → "Tracked debts") where they can be **collected**
(records a real `Payment` for the amount) or **voided** (written off). Verified by a
40-assertion engine matrix + a browser click-through of the full lifecycle.
- **Deferred nuance:** for a session-plan visit closed while unpaid, the shortfall
  lives on the plan (`sessionsToPayFor`), not as a `ClientDebt`, and there is no
  path to advance that plan's `sessionsPaid` from the now-terminal `cleared_with_debt`
  basket. Collecting it happens naturally on a future visit's session charge. This
  is intentional (avoids double-tracking) but worth remembering.

**Fixed — #14 tab reset on refetch (app-wide):** a manual `useApi().refetch()` used
to flip `loading` back to `true`, so any page that gates on `loading` (e.g. the
client profile's `if (loading) return <Loading/>`) unmounted and remounted its
subtree, resetting in-view state like the active `Tabs` tab. `refetch()` is now a
**background refresh** — it keeps showing the current data and never flips
`loading`, so the active tab (and any other in-view state) survives a
collect/void/save. The initial load and deps changes still show the full-screen
loader. ([use-api.ts](../src/lib/use-api.ts).)

---

## Open issues — logged, not yet fixed


Each item: what's wrong · where it lives · severity.

### ⚠️ #6 — Appointments can be double-booked
Nothing stops two appointments from being created for the same dietitian at the
same date and time; there's no slot-conflict check.
- **Where:** [appointments.ts `createAppointment`](../src/server/repositories/appointments.ts) — no validation before create.
- **Effect:** Two clients booked into one slot; discovered only when both arrive.

### ⚠️ #7 — Duplicate patient / staff-email edge cases
Patient de-duplication compares phone numbers in JavaScript with no database
constraint, so two near-simultaneous registrations can both pass and create
duplicates. Staff email uniqueness _is_ enforced by the DB, but the resulting
error surfaces as a raw "Internal server error" instead of a friendly message.
- **Where:** [clients.ts `createClient`](../src/server/repositories/clients.ts) (phone check); [staff.ts `createStaff`](../src/server/repositories/staff.ts) + [http.ts `handleError`](../src/server/http.ts) (no P2002 → 409 translation).
- **Effect:** Possible duplicate records under load; confusing 500 on a duplicate email.

### 💡 #9 — Staff/consultation stats matched by name, not ID
Per-dietitian consultation counts are computed by comparing full-name strings,
even though stable IDs exist.
- **Where:** [dashboard.ts](../src/server/services/dashboard.ts) — `staffActivity` and the `dietitianName` match in `recentConsultations`.
- **Effect:** Two staff with the same name, or a renamed dietitian, mis-attributes or zeroes their numbers.

### 💡 #10 — "Amount edited" badge / history can bleed between same-titled expenses
Whether an expense's amount was edited is detected by scanning audit-log text,
with a legacy fallback that matches on the expense _title_.
- **Where:** [expenses.ts `listExpenses`](../src/server/repositories/expenses.ts) (`amountEdited`) and `listExpenseAudit`.
- **Effect:** Editing one "Groceries" expense can flag another "Groceries" as edited or show its history.

### 💡 #11 — Receipt numbers never reset per year despite the "current year" label
The receipt counter is a single global running sequence; the `RCP-2026-…` year is
cosmetic and won't restart in a new year. (The #2 fix made the sequence safe; it
did not change this per-year behaviour.)
- **Where:** [payments.ts `nextReceiptNumber`](../src/server/repositories/payments.ts).
- **Effect:** Minor — could confuse year-end bookkeeping that expects per-year numbering.

### 💡 #12 — Expense "created" audit log isn't transactional
Creating an expense writes the expense and its audit entry as two separate steps
(the _update_ path correctly wraps both in a transaction).
- **Where:** [expenses.ts `createExpense`](../src/server/repositories/expenses.ts).
- **Effect:** A failure between the two leaves an expense with no "created" audit record.

### 💡 #13 — "New this month" client count has no month-end cap
The count includes everyone registered on or after the 1st of the month, with no
upper bound, so a client registered in a _later_ month still counts toward the
current month.
- **Where:** [dashboard.ts](../src/server/services/dashboard.ts) — `counts.newThisMonth`.
- **Effect:** Low impact today (demo uses a fixed "today"); would over-count once the date is live.

---

## Things to address before / during V3 (real authentication)

Items 1–4 below are **done** (real sessions landed — see `CLAUDE.md` → "Version 3 —
how auth actually works now"). Kept here for the historical record; 5–7 are still
open and weren't in scope for that pass.

### 1. ~~Role guards trust a self-reported demo role~~ — done
`server/auth.ts`'s guards now derive the role from a verified, DB-backed session
(cookie → `Session` row → `User`), not a client-supplied header. No call-site
changes were needed beyond adding `await` — exactly as anticipated.

### 2. ~~Login is a client-side role picker~~ — done
`POST /api/auth/login` verifies a real email + password (Argon2id) and issues a
server session; the top-bar "Demo role"/"Acting as" switchers (a real impersonation
hole) were removed.

### 3. ~~Passwords are never set or verified~~ — done
`hashPassword`/`verifyPassword` (`src/server/password.ts`) are used at login, at
staff creation (`createStaffSchema` now requires a password), and in
`prisma/create-admin.ts` (the only way a user ever gets into this database —
there is no seed data).

### 4. ~~The acting user is passed in from the client for writes~~ — done
`createdById`/audit attribution already flowed through `actingUser(req)` (see
`payments`/`expenses` routes) rather than trusting body-supplied fields directly —
now that `actingUser` itself resolves from the verified session, this is no longer
forgeable.

### 5. ~~`staff/[id]/supplements` has no ownership check~~ — done
Worse than originally described: the route had **no auth check at all**, not
just a missing ownership check. Fixed: requires a signed-in session, and the
caller must be the owning dietitian or an admin (`actor.id !== id && actor.role
!== "admin"` → 403).
- **Where:** [staff/[id]/supplements/route.ts](../src/app/api/staff/[id]/supplements/route.ts).

### 6. ~~Dashboard returns full clinic financials to every signed-in role~~ — done
Fixed server-side, not left to the client UI: `getDashboardSummaryForRole` now
redacts the aggregate report figures (income/expenses/profit/margin/unpaid
balance, packages-sold, revenue series, staff activity, referrer report,
outstanding-debt list) for every role except admin. `paymentsToday`/
`recentPayments` — day-to-day front-desk operations, not "reports" — stay
visible to secretary (who actually records payments) but not dietitian.
- **Where:** [dashboard route](../src/app/api/dashboard/route.ts) + [services/dashboard.ts](../src/server/services/dashboard.ts) `redactForRole`.

### 7. Sidebar access control is UI-only
`canAccess` decides which nav items show, but it's presentational — server guards
are the real enforcement.
- **Where:** [lib/nav.ts `canAccess`](../src/lib/nav.ts).
- **V3:** treat it as convenience only; keep verifying that every page's data
  endpoints are guarded server-side as new pages are added.

### 8. Other CLAUDE.md deferrals — now resolved
The items this section used to defer to V3 have since landed or been superseded:
audit-log-on-write is live across the mutating repos, queue status transitions now
persist via the API, the new-client wizard was reworked (no payment/appointment
steps), and "payment → package `paymentStatus` recompute" was replaced by the
`SessionPlan` + `ClientDebt` systems above. They now also run against a verified
session rather than a self-reported role (items 1–4), so the old trust caveat no
longer applies.

### 9. Also resolved in the post-launch security hardening pass
HTTP security headers, admin-initiated staff password reset, and TOTP 2FA
(admin role) all landed — see `CLAUDE.md` → "Hardening pass".

**Password recovery is admin-only by design, not a gap.** There is no
self-service "forgot password" email flow, and none is planned — a staff member
who forgets their password gets it reset by an admin (Staff page → "Reset
password"). This was an explicit product decision (no email provider needed,
one less moving part), not a deferred V4 item.

One item from that review is still open:
- **No IP-based/distributed rate limiting** — only per-account lockout (5 failed
  attempts → 15 min, `src/server/session.ts`). Fine standalone; if deployed
  behind something other than a platform that already throttles at the edge
  (Vercel, Cloudflare), this is more exposed to distributed brute-forcing.

### 10. Full route-by-route auth audit (pre-deploy) — done, one systemic item flagged
A sweep of every `src/app/api/**/route.ts` handler (prompted by items 5/6 above
turning out to be part of a pattern) found **six more routes with no auth check
at all**, now fixed the same way as item 5 (require a signed-in role; admin-only
catalog cost figures still stripped for non-admin roles same as before):
- `clients` GET, `clients/[id]` GET, `clients/by-phone` GET — were serving
  non-clinical client data (names/phones/emails, or a specific client's detail
  record) to unauthenticated callers. `canViewClinical` was still correctly
  gating the *clinical* fields — the base session check was just missing.
- `referrers` GET, `settings` GET — low-sensitivity payloads (referrer names;
  the exchange rate), but were open to anyone regardless.
- `packages` / `products` / `service-prices` GET — `cost`/margin was correctly
  stripped for non-admin, but the base (non-cost) catalog was reachable
  unauthenticated; now requires a signed-in role like every other list route.

**Flagged, not fixed — a product decision, not a bug:** the audit also found
that *no* list endpoint scopes rows by the acting dietitian/secretary — every
role that passes a route's guard gets the full clinic-wide list. Per
`docs/01-product-spec.md` §2.2, a dietitian is *supposed* to see only clients
assigned to them plus anyone on their day's queue (with an admin override to
"see all"). Implementing that is a real feature (touches `listClients`,
`listAppointments`, `listConsultations`, `listPayments`, `listVisitBaskets`,
`listBloodSamples`, and the dashboard aggregation), not a quick patch, and it
would change real workflows (e.g. whether one dietitian can currently pull up
another's client during a walk-in). Deliberately left as an open decision
rather than silently implemented — revisit before onboarding multiple
dietitians who shouldn't see each other's caseloads.
