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

### 8. Referrer commission (per-referral fee) — behaviour notes
The admin sets a per-referral fee on each `Referrer` (Settings → Referrers). The
fee is **frozen onto the patient** (`Client.referralFee`, always USD) at the
**registration moment** — `createClient`, which every registration path goes
through: the full new-client form *and* a phone booking both capture the referrer
there (`createClientSchema` requires `referralSource`). The rate is snapshotted at
that day's `Referrer.fee`, so a later rate change never re-prices past referrals
(same freeze-at-use rule as frozen prices / exchange rates). It's a one-time cost,
deducted from **net profit** and **gross margin** (`services/dashboard.ts`),
windowed by registration date like the other flow figures, and surfaced as the
"Referrer cost" card + drill-down on the dashboard and reports (admin-only,
redacted for other roles).

Every referrer dropdown (new-client form, phone booking, check-in) also offers a
built-in **"None — came on their own"** choice (`NONE_REFERRER` in `lib/config.ts`)
for organic/walk-in patients. It's stored as the literal `referralSource` "None"
and always carries **no fee**: `resolveReferralFee` short-circuits it to null even
if a `Referrer` row named "None" somehow existed, and `create/updateReferrerSchema`
reserve the name so an admin can't add a conflicting list entry. Organic patients
still show as a "None" group in the referrer *count* report but never appear in the
referrer *cost* breakdown.

Editing a patient's `referralSource` later (`updateClient`, e.g. at check-in) is
a **correction to the record, not a new registration** — it deliberately does
**not** (re)freeze the fee. This keeps the semantics unambiguous: the commission
is captured exactly once, at that day's rate, and a referrer whose fee was $0 at
registration never has a later rate retroactively attached.

Minor edge case, deliberately left as-is (retroactivity is a non-concern —
feature shipped before real data): the freeze is genuinely one-time, so if an
admin later **changes a patient's referrer** to a different one, the frozen fee
does **not** move to the new referrer's rate. The money stays correct, but that
patient then appears in the cost breakdown under their *current* `referralSource`
name carrying the *old* referrer's frozen amount. Rare manual-edit path.

---

## 9. Food List (Nutrient-Rich Foods List) — fidelity notes

The Food List card in the consultation editor and its generated PDF reproduce
Layaka's paper form ("Patient paper english.docx"). The layout in
`src/server/pdf/food-list-pdf.ts` is a transcription of the document's real
geometry — shape offsets/extents read out of `word/document.xml` and cross-checked
against a render of the original — not an eyeball approximation. Where an exact
match wasn't possible, this is what differs and why:

**Fonts (cannot be exact).** The document uses **Calibri** (item labels,
headings), **Calibri Light** (title) and **Segoe UI Symbol** (the ☐ glyph) — all
proprietary Microsoft fonts that can't be redistributed or embedded in a PDF. The
PDF uses **Carlito**, an OFL font that is *metric-compatible* with Calibri
(identical advance widths, so text occupies exactly the same space and breaks in
the same places), plus **Lato** (OFL) for the subtitle/footer, which the document
itself specifies. Letterforms are very close but not identical. The document also
mixes Lato and Trebuchet MS inconsistently in the subtitle/footer — that
inconsistency was not reproduced; those lines are uniformly Lato.

**Checkboxes are drawn, not typeset.** With Segoe UI Symbol unavailable, the box
and its tick are vector-drawn. This is also why a ticked item renders as a clean
checkmark rather than a substituted glyph.

**Column count.** The printed form is **four** columns (measured x-offsets 0.34" /
2.41" / 4.38" / 6.25", deliberately bleeding outside the 1" margins). The PDF
matches that exactly. The **on-screen** form reflows responsively (1–3 columns by
breakpoint) because four columns of checkboxes are unusable inside the editor card
on a narrow screen — a deliberate divergence, screen only.

**Name / Notes placement.** On paper these sit at the **bottom** of the sheet,
below the food columns; the PDF matches. In the **web form** they're at the top,
where they're more useful when filling it in.

**Text metrics — the three things that make the columns match.** These were all
read out of `word/document.xml`; guessing any of them produces text that crowds or
is clipped by the box borders:

1. **Insets are 0.1in left/right, 0.05in top/bottom** (`<wps:bodyPr lIns/rIns/tIns/bIns>`,
   identical on every box). This is the padding that keeps labels off the border.
2. **Line spacing is not uniform.** The form was hand-built and the boxes were
   formatted differently: `w:line="276"` (1.15×) on Vegetables / Eggs and Dairy /
   Other Foods, `280` (~1.167×) on Nuts and seeds, and single spacing on Fruits /
   Animal proteins / Plant-based proteins / Carbohydrates. `LINE_SPACING` carries
   these per category. One shared pitch makes some columns overflow their box and
   leaves others visibly loose.
3. **A wrapped continuation line gets the FULL inner width.** Only the first line
   of an item shares its row with the checkbox; wrapped lines start at the box's
   left inset. Measuring every line against the narrower first-line width splits
   "Walnuts / Pistachios" onto a third line, where the paper form keeps it on one.

Every label that wraps on the paper form wraps identically here: "Melon /" +
"Watermelon", "Regular / Greek" + "Yogurt", "Labneh / White" + "Cheese",
"Carbonated" + "Beverages", "Pasta / Pizza /" + "Flour", "Chickpeas / Fava" +
"Beans", "Almonds /" + "Walnuts / Pistachios", and the "Herbs: …" line over three.

`tokenize()` keeps a lone "/" or "-" attached to the word before it, as a
break-opportunity rule applied while measuring. Don't "fix up" a stranded
separator after wrapping instead — moving it back onto the previous line can push
that line past the margin, which is exactly how a label once ended up half a point
from its border.

**Box heights auto-grow when needed.** Each box is drawn at
`max(document height, content height + insets)`, so a label can never be clipped.
At the current catalog only "Nuts and seeds" grows (by ~9pt); every other box has
slack at the document's own height. If items are ever added to a category, check
the grown box doesn't collide with the next heading in the same column.

**Notes is a single ruled line.** The paper form gives Notes one rule. A long note
steps down in type size and may run to a second line before it is truncated with
an ellipsis; the editor says so under the field. Free text is also filtered to
characters the embedded font subset can encode, so a pasted emoji (or Arabic, in
the English form) is dropped rather than throwing during generation.

**Dropped from the original:** a stray Arabic word (`نشوي`) left in the document
body, and a white masking rectangle whose only job was trimming the header band.

**Verifying a layout change.** Don't eyeball it. macOS Quick Look
(`qlmanage -t -s 1600 -o out file.docx`) will render the .docx, but it substitutes
its own font and lets text overflow — its box geometry is trustworthy, its line
breaks are not, and taking them at face value is what produced the clipping bug in
the first place. Prefer measuring against `word/document.xml`, and assert the
result: for each category compute the wrapped lines and check the gap from the
longest line to the box's right border and from the last baseline to the bottom.
Current minimums are ~9.9pt right and 3.6pt bottom (the document's own inset).

**Arabic edition — not built.** The language picker shows Arabic as a disabled
"coming soon" option. `ConsultationFoodList.language` already stores `"en"`/`"ar"`,
so the Arabic form needs no migration — it needs a translated catalog and an
RTL-aware renderer (and an Arabic-capable embedded font; the current subsets are
Latin-only).

**Permissions.** Filling in and generating follow the consultation editor
(doctor/admin, `canViewClinical`). The finished PDF is downloadable by **every**
role — the front desk hands it to the patient — so `/api/consultation-files/[id]`
and `/api/clients/[id]/consultation-files` gate on "signed in" rather than
clinical access. To make that reachable, the client profile's **Files tab is now
visible to the secretary**, scoped: she sees consultation documents only, never
blood-test lab results (still `canViewClinical`, enforced server-side).

**Regeneration replaces.** Only one PDF per visit per `kind` is kept — regenerating
after ticking another box leaves one current sheet rather than a pile of
near-identical ones. The audit log records each (re)generation.

---

## 10. Food List — the Arabic edition

The Arabic form ("Patient paper 1.docx") is the same 94 items as the English one,
mirrored right-to-left. Both editions share one renderer
(`src/server/pdf/food-list-pdf.ts`); everything language-specific lives in the
`LAYOUTS` table, so a drawing change applies to both and English can't silently
drift. Selections are **language-independent** — item ids are shared, so a form
ticked in English prints unchanged in Arabic and switching language never loses a
tick.

**The layout is a clean mirror.** Reading order runs right-to-left: Vegetables is
the RIGHTMOST column, then Fruits/Nuts, then Animal/Plant-based/Carbohydrates,
then Eggs and Dairy leftmost. Checkboxes sit to the right of their label,
headings are right-aligned with the leaf bullet on the right, and Name/Notes move
to the bottom-right with their rules running leftwards. The header band, the
specialities strip, the QR code, the wordmark and the footer are **byte-identical**
between the two documents — the footer deliberately stays Latin with Western
numerals, so it is not translated.

**The source text needed normalising.** The Arabic document stores most of its
text as pre-shaped **Arabic Presentation Forms** (460 chars in `U+FE70–FEFF` /
`U+FB50–FDFF` against 319 in the normal `U+0600` block), with Persian/Urdu letters
mixed in — 46 × Farsi Yeh (`ی` U+06CC) and 6 × Heh Doachashmee (`ھ` U+06BE). Used
verbatim these render as broken, disconnected letters and break search, copy/paste
and screen readers. The catalog therefore stores NFKC-normalised standard Arabic
with `ی→ي` and `ھ→ه` folded. `ى` (alef maksura) is deliberately left alone — it is
correct in words like `أخرى`. The 94 labels were reviewed and approved before
shipping; **if labels are ever re-extracted from the .docx, they must be
re-normalised the same way.**

**Three things that make Arabic render correctly** — all learned the hard way:

1. **Never reorder characters for RTL.** fontkit (which pdf-lib delegates to)
   already shapes Arabic and reverses RTL runs internally. Applying the bidi
   reordering to characters double-flips them and produces backwards, disconnected
   text. `visualRuns()` splits into runs of uniform direction, keeps each run in
   LOGICAL order, and reorders only the RUNS. This is what makes a Latin patient
   name inside the Arabic Name field come out right.
2. **Don't trust Noto Sans Arabic's line metrics.** It declares a 26.4pt line box
   at 12.5pt (Carlito declares 15.26pt) to leave room for vocalisation marks the
   form never uses. Taken at face value every column overflowed its box and
   collided with the category below. `itemLineHeightPt: 19.8` on the Arabic layout
   is the document's own implied pitch, consistent across six of its eight boxes.
3. **An unspaced "/" is a break opportunity.** `معكرونة/بيتزا/طحين` is a single
   whitespace-delimited word too wide for its column; without a break after the
   solidus it broke mid-word. `tokenize()` handles this and returns tokens tagged
   with whether the source had a space, so re-joining never invents one. No English
   label contains an unspaced slash, so that edition is unaffected.

**Padding is a deliberate deviation.** The Arabic document sets ALL text-box
insets to **zero**, so its text sits flush against (and clipped by) the box
borders. The English insets (0.1in left/right, 0.05in top/bottom) are applied to
both editions instead — a decision taken with the clinic, favouring legibility
over exact reproduction. One visible consequence: `معكرونة/بيتزا/طحين`
(Pasta / Pizza / Flour) wraps onto two lines here where the source keeps it on one
by overflowing its border.

**Fonts.** The Arabic document pins no Arabic typeface at all — its theme's
complex-script entry is literally empty — so there was no original to match.
Noto Sans Arabic (OFL) was chosen for legibility and is subset **with its layout
features intact** (`--layout-features='*'`); dropping GSUB/GPOS would break Arabic
shaping entirely. The Latin faces keep their smaller feature-stripped subsets.

**Verifying a change to either edition.** Render both, then assert:
- the English page is **pixel-identical** to before (it is a regression otherwise —
  `LAYOUTS.en` and the English constants must not move);
- every box in both editions clears its borders (current minimums: English 6.9pt
  left / 10.8pt right; Arabic 11.8pt left / 7.4pt right).
Render Arabic crops at 2600px+ when eyeballing them — at ~1250px the dots under a
final `ي` are near sub-pixel. But do **not** write off misplaced dots as a raster
artifact: that call was made once here and it was wrong. See below.

**Arabic dots are drawn by us, not by `page.drawText`.** Noto Sans Arabic's `ccmp`
feature splits every dotted letter into a dotless base plus a SEPARATE
ZERO-ADVANCE mark glyph for the dots, whose only placement is a GPOS
`xOffset`/`yOffset`. pdf-lib throws those away — `CustomFontEmbedder.encodeText`
keeps the fontkit run's `.glyphs` and drops `.positions`, and `xOffset`/`yOffset`
appear nowhere in its runtime code. Every dot therefore collapsed onto its base's
origin: a final Yeh's two dots landed 0.232em low and 0.185em to the side, so
`فول سوداني` printed with a stray mark below the tail instead of dots under the
letter. This affected roughly every dotted letter on the page (`ش`, `ت`, `ب`, `ن`,
`ي`, `ز` …), was in the vector content of the real PDF, and was NOT a screenshot
artifact.

`drawShaped()` fixes it by emitting positioned glyphs itself. Two constraints on
that code:
- The Arabic face must be embedded with **`subset: false`**. We emit raw glyph
  ids, and `CustomFontSubsetEmbedder` renumbers them through `subset.includeGlyph`.
  Costs ~45KB in the Arabic PDF only (60KB → 105KB); the English PDF is untouched.
- **Disabling `ccmp` is not the fix**, though it looks like one — the font does
  contain precomposed dotted glyphs. Its `init`/`medi`/`fina` lookups match on the
  decomposed bases, so without `ccmp` every letter falls back to its isolated form
  and cursive joining breaks (`فو` measures 1029 units joined vs 1548 unjoined).

Positioning each glyph absolutely also applies GPOS `xAdvance`, i.e. the kerning
`widthOfTextAtSize` ignores. 24 of 104 Arabic strings measure narrower as a
result; none measure wider, so box clearances only improved. Current Arabic item
clearances: 4.61pt below the last baseline and 4.40pt above the first.
