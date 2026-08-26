# Known Issues & V3 Readiness

_Last updated: 2026-08-12._

A running checklist so we don't lose track of known-but-unfixed items as the
project grows. Item numbers match the codebase health-check audit. Nothing here
is fixed yet — these are logged on purpose.

Already fixed (for reference, not open): receipt-number collisions (#2), basket
settlement double-charge (#3), missing permission checks (#1), recurring-cost
history freezing (#4, which also incidentally fixed the currency-switch stale-rate
concern — a currency change now re-snapshots the exchange rate for the new period),
and double-booking (#6 — see "Appointment slot uniqueness" below).

**Upfront plan billing / `SessionPlan` (implemented, wired into the UI):**
pay-as-you-go clients (NOT on a fixed-price package) have a `SessionPlan` tracking
`sessionsNeeded / sessionsUsed / sessionsPaid`, with derived credit (`paid − used`),
built as a **separate system** from Packages (fixed-price package logic is
untouched). A visit bills the plan's whole unpaid balance
(`sessionsNeeded − sessionsPaid`) at the machine's catalog per-session price;
"sessions used today" is consumption only and never sets the amount charged. A
visit that only draws on existing credit raises no basket at all. `sessionsUsed`
advances when the visit is saved; `sessionsPaid` advances only at settlement (by
the settled quantity, inside the same atomic transaction as the payment). The
dietitian links a treatment to a plan from the consultation editor's "Bundle &
sessions" card, which previews the charge through the same kernel the server bills
with. Full behaviour: `CLAUDE.md` → "Session plans, bundles & billing".

**Client debt / clearance (Phase 2, implemented):** money a client couldn't cover
at checkout is recorded as a tracked `ClientDebt` (`source: secretary_override`)
alongside a payment for what was actually collected, instead of being left
uncollected. Session-plan charged lines are **never** deferred this way — a plan is
paid upfront in full, so only the non-plan portion of a basket may be entered as
debt (capped in `settleVisitBasket`; `updateVisitBasket` likewise refuses any edit
to a plan line at checkout). Debts show on the client profile (Payments tab → "Tracked debts") where they can be **collected**
(records a real `Payment` for the amount) or **voided** (written off). Verified by a
40-assertion engine matrix + a browser click-through of the full lifecycle.
- A visit can no longer be closed with money still outstanding: `closeConsultation`
  refuses while a `pending` basket exists (`assertBasketSettledTx`), so every visit
  is settled — in full, or with the non-plan remainder recorded as a `ClientDebt`
  at settlement — before it is finalized.

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

Two further gaps in the billing area have since closed: **one active session plan
per client per machine** is now enforced by the database (the partial-unique
`activeMachineKey`, not just by the UI), and a deleted or edited-down visit no
longer leaves a phantom purchase balance on a plan
(`reconcileSessionPlanNeedsTx`). **Refunds are not a gap:** money once collected is
never reversed and a visit with a settled basket can't be deleted — that is the
clinic's rule, not a missing feature.

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

The Arabic form ("Patient paper 1.docx") is the same 107 items as the English one,
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
correct in words like `أخرى`. The 107 labels were reviewed and approved before
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

## 11. Food List — sending via WhatsApp, and the auto-generate fallback

### What "Send via WhatsApp" can and cannot do
**WhatsApp does not let a web page attach a file to a chat.** No `wa.me` /
`api.whatsapp.com` parameter carries an attachment; it's a platform restriction
applied to every website, not a gap here, and there is no workaround. So the
button does the two automatable halves — downloads the PDF, and opens a chat on
the patient's number with a short message pre-typed — and the person sending
still attaches the downloaded file by hand. `WHATSAPP_ATTACH_HINT`
(`src/components/SendViaWhatsAppButton.tsx`) is the one place that wording
lives; both hosts render it. **Don't reword it into a promise the platform can't
keep.**

`wa.me` is deliberate: `web.whatsapp.com/send` is desktop-only and breaks on a
phone, and `whatsapp://` dead-ends when the desktop app isn't installed. `wa.me`
lets the sender's own machine choose.

The download and the `window.open` both fire synchronously in the click handler,
with **no `await` between them** — the moment the handler yields, the browser
stops treating the `window.open` as user-initiated and the pop-up blocker eats
the chat window. That's also why the button takes an already-generated file
rather than generating one on demand.

Shown wherever a Food List PDF can be downloaded (the consultation editor's Food
List card and the client profile's Files tab), to **all three roles** — the
secretary hands the form over as often as the doctor does. Only *generating* the
PDF stays clinical-only. Lab-result rows never get the button.

### Phone numbers must be dialable, and we don't guess
`whatsAppChatUrl` returns `null` unless the stored phone names its country **and**
has a plausible national number for it (`isValidInternationalPhone`,
`src/lib/phone.ts`). The button then renders disabled in amber with what to fix.
Guessing a missing country code would mean opening a chat with a stranger and
sending them another patient's form, and a code with an impossible number
("+961 12") is just as wrong to dial.

`src/lib/phone.ts` now holds the dial-code table and length rules that used to
live inside `components/ui/Field.tsx`; that file re-exports `isValidPhone` so
existing imports are unchanged. The move exists so the **server** can apply the
same rules: `createClientSchema`/`updateClientSchema` validate patient phones
with `isValidInternationalPhone`, closing the gap where a direct API call
(bypassing `PhoneInput`) could store an undialable number. Note `isValidPhone`
stays deliberately laxer — it assumes Lebanon for a bare number so the input
field stays usable mid-typing — so **use `isValidInternationalPhone` for anything
that actually dials**. Staff phones are not covered (optional, never messaged).

### Auto-generate on close
Closing a visit finalizes it read-only, so a doctor who filled the form in but
never pressed "Generate PDF" would leave nothing to hand over and no way back.
`ensureFoodListPdf` (`src/server/services/foodListPdf.ts`) runs after close
commits, from both close paths (`POST /api/consultations` with `close`, and
`PATCH /api/consultations/[id]` with `close`).

- Generates when a form exists with ≥1 tick and either no PDF exists yet, **or**
  the form was edited after the last PDF was made (ticking more boxes then
  closing must not leave a stale sheet; `saveConsultationFile` replaces in place,
  so there's still exactly one current file).
- No-ops when no form was filled in, or when nothing is ticked.
- **Never throws.** Close has already committed; a font that won't load must not
  report a finalized visit as an error, or invite a retry of a close that already
  happened. Failures are logged and swallowed.

It runs at the **route** layer, outside the close transaction, on purpose:
rendering reads fonts/artwork from disk and takes real time, and must not extend
or fail the DB transaction.

That staleness check depends on `ConsultationFoodList.updatedAt` meaning "the
form actually changed". It didn't: `buildConsultationContentTx` upserted the row
on every save, and re-saving a draft resends the whole form, so `updatedAt` moved
even when nothing changed — and every close re-rendered the PDF for nothing (plus
a bogus "Regenerated Food List PDF" audit entry). The upsert now **skips the
write when language/patientName/notes/selections all match**. Anything else that
starts keying off `updatedAt` inherits that guarantee; don't remove it.

---

## 12. Rescheduling appointments — permissions, reach, and the booking mismatch

Moving an existing booking to a new slot. Added after the Food List work; this
section is the reference for what it does and does not do.

### What it is
`PATCH /api/appointments/[id]/reschedule` edits the appointment **in place** —
same row, same id, status stays `scheduled`. It changes only date, time, doctor
and visit type. It is deliberately a separate endpoint from the sibling
`PATCH /api/appointments/[id]`, which is the status-transition write used by the
queue and by cancellation: one touches the slot and never the status, the other
touches the status and never the slot.

Chosen over cancel-and-rebook so a moved appointment keeps its identity (nothing
downstream has to be re-pointed) and the profile shows one row per booking rather
than a cancelled/scheduled pair. **Trade-off:** there is therefore no record of
the previous slot — the appointment's history is not versioned. If an audit trail
of moves is ever needed, that's a new table, not a tweak.

### Rescheduling clears the reminder stamps
`reminder24hSentAt` / `reminder2hSentAt` record that the patient was told about
the **old** slot, and `runAppointmentReminders` only picks up rows where they are
null. An in-place move therefore has to null both, or the patient silently gets
no reminder for the slot they were actually moved to. `rescheduleAppointment`
does this in the same write — don't remove it.

### Who can do it
Secretary and admin. **A dietitian cannot** — `canManageAppointments`
(`src/server/auth.ts`) returns 403, and every UI surface gates on the matching
positive role test. Verified live: identical request returned `403` as dietitian,
`200` as secretary, `200` as admin, `403` with no session.

Note this is *narrower* than the sibling status endpoint, which any signed-in
role may call — a dietitian can still advance their own queue, they just can't
move a slot. That asymmetry is intentional.

### Where it's offered
Client profile → Appointments tab · Appointments & history (day table) · Queue
board, **including the other-day board**, which is otherwise read-only — an
upcoming booking is exactly what the front desk gets phoned about. Eligibility is
the same predicate everywhere (`isReschedulable`, exported from
`components/ScheduleAppointmentModal.tsx`): status `scheduled` **and** not in the
past. It mirrors the server guard so the UI can't offer what the API refuses.
Verified live: `checked_in`, `with_dietitian`, `completed`, `cancelled` and
`no_show` all return `409 Only a scheduled appointment can be rescheduled.`

### ⚠️ Booking permissions don't match rescheduling's
`POST /api/appointments` guards on `actingRole` only, so **any** signed-in role —
including a dietitian — can create an appointment through the API. The UI hides
booking from dietitians (`canBook`), so this is a UI-only restriction, the same
class of gap as §7's sidebar. Rescheduling is enforced on both sides; booking is
not. Left as-is rather than silently tightening a pre-existing endpoint — but if
booking is meant to be front-desk-only, `POST /api/appointments` should move to
`canManageAppointments` too.

### Appointment slot uniqueness (closes #6)
**Stale note removed**: this section used to say "no schema change" / "no DB
uniqueness backing it" — that's no longer true. `Appointment.activeSlotKey`
(`prisma/schema.prisma`) is a mirror of `clientId|date|time`, set only while a
booking is ACTIVE (`scheduled`/`checked_in`/`with_dietitian`), and carries a
`@@unique` index. A client can't be double-booked at the same date/time whether
unassigned, assigned to one dietitian, or split across two different
dietitians — the same key collides in all three cases. Every write that can
change status, date or time (`createAppointment`, `updateAppointmentStatus`,
`rescheduleAppointment`, all in
[appointments.ts](../src/server/repositories/appointments.ts)) recomputes the
key through the shared `activeSlotKey()` helper and translates the resulting
Postgres `P2002` into a `409` ("This client already has an appointment at this
date and time.") — never a raw 500. Terminal statuses (`completed`, `cancelled`,
`no_show`) null the key out, so history and rebooking a freed slot are
unaffected. Two *different* clients can still be booked into the same
dietitian/date/time — this only protects one client from being in two places at
once, it is not a doctor-capacity check. First introduced (dietitian-scoped
only) in migration `20260820120000_one_active_appointment_per_slot`; widened to
also cover unassigned and cross-dietitian collisions in
`20260825120000_appointment_slot_key_drops_dietitian`, which also cancels any
pre-existing duplicate bookings it finds under the new rule (non-destructive —
duplicates stay in history, just no longer occupying the slot).

## 13. Food List PDF — concurrency (audit fixes #1, #2, #3, #5)

A review of the Food List PDF pipeline found that "one current PDF per visit"
and "one save at a time" were both timing assumptions rather than enforced
rules. Fixed; reproduced first with real overlapping-write tests, which live in
[`tests/race/`](../tests/race) and run with `npm run test:race` against a
dedicated `*_test` database (the runner refuses any other name).

### The window that made it reachable (#1, #5)
"Generate PDF" is a chain: save silently → render → adopt the new visit's id into
the URL. `saving` went back to false after the first link, while `editId` was
still empty, so Save and Close looked available in the middle of it. What a click
in that window actually did — measured, not assumed:

- **Save** → the server's "one open visit per client" guard (`createConsultation`)
  returned the visit that had just been created and skipped writing, so the
  doctor got "Saved — visit in progress" while their edits were **silently
  dropped**.
- **Close visit** → same path, and because that guard returns before the close
  block, the visit was reported closed (and the editor swapped to the saved
  screen) while it stayed **open** in the database.

A *duplicate visit row* — the risk the audit named — needs two `createConsultation`
calls genuinely in flight together, which the test suite confirms does fork the
visit (two rows, both `visitNumber` 1). The gap plus a double-click is how a
doctor would get there.

Both are now closed off in the editor: `busy = saving || generatingPdf` disables
Save, Close and Delete for the whole chain, and `save()` refuses re-entry through
a ref synchronously, because `busy` only takes effect at the next render and a
double-click doesn't wait for one.

### One file per visit per kind, in the database (#2)
`ConsultationFile` now carries `@@unique([consultationId, kind])` (migration
`20260812140000_one_consultation_file_per_kind`, which collapses any existing
duplicates to the newest row first). `saveConsultationFile` upserts against that
key instead of find → delete → create; losing an insert race raises P2002, which
is retried once as a plain replace and never reaches the doctor. Both renders are
byte-identical anyway, so last-writer-wins is the correct outcome here.

Two consequences worth knowing:
- The row's **id is now stable** across regenerations. Downloads send
  `Cache-Control: private, no-store`, so a stable URL can't serve a stale sheet.
- The upsert **moves `createdAt` forward** on replace, exactly as delete-and-recreate
  did. That column is the staleness signal at close — if it ever stops being
  refreshed, a regenerated sheet looks permanently older than the edit that
  prompted it.

### Closing a visit is claimed, not just checked (#5)
`closeConsultation` read `status`, logged the discount/fee-waive entries, then
wrote `closed`. Two closes arriving together both read "open", so both logged and
both fired the Food List catch-up. The status write is now a conditional
`updateMany` on `status: "open"` placed **before** the logging: the second caller
waits on the row lock, matches nothing, and gets the existing
`"This visit is already closed."` conflict.

### Staleness reads the newest file (#3)
The close-time check in `ensureFoodListPdf` takes one file with
`orderBy: { createdAt: "desc" }`. The constraint above means there is only one —
the ordering is what keeps the comparison correct for rows that predate it, and
the test drops the index for the duration to prove it against a two-file visit.

### A stale sheet can't be sent (#4)
`isFoodListPdfStale` ([src/lib/food-list.ts](../src/lib/food-list.ts)) is now the
one definition of "this PDF prints superseded answers", used by all three places
that care: the close-time catch-up, the `stale` flag every file listing returns,
and "Send via WhatsApp", which turns into a "Regenerate the PDF before sending"
notice rather than handing over the old form.

It **blocks rather than regenerating on the way out** on purpose: regenerating
means awaiting the server, and the moment the click handler yields, the pop-up
blocker eats the chat window — the same one-gesture constraint (§11) that already
rules out generating on demand from that button. The doctor regenerates (or
closes the visit, which regenerates), then sends.

The flag is the affordance, not the guarantee: it's only as current as the
listing it came from, so a Files tab left open while the form is edited in
another tab would still show a live button. The send therefore asks for the bytes
with `?intent=send`, and
[the download route](../src/app/api/consultation-files/[fileId]/route.ts) re-checks
freshness at that moment and answers `409 {code:"stale_food_list"}` — the button
reports it and turns into the regenerate notice. A plain download is deliberately
unaffected: staff may still fetch an old sheet on purpose.

The editor's card additionally tracks edits **not saved yet**
(`foodListChangedSincePdf`), which the server's flag can't see; it's seeded from
that flag when a saved visit is re-opened and cleared when the PDF is generated.

### Failed generation is reported (#6)
Still silent for the user — a visit that has already closed must not turn into an
error — but no longer silent for you.
[`src/server/observability.ts`](../src/server/observability.ts) writes one
structured line to `console.error` (whatever runs the app captures stderr; no new
dependency, no monitoring service):

```
{"level":"error","event":"food_list_pdf.failed","consultationId":"…","trigger":"close","stage":"render","language":"en","selectionCount":12,"errorName":"Error","errorMessage":"ENOENT: no such file or directory, open '…/fonts/Carlito-Bold.ttf'"}
```

Alert on `event`. `trigger` separates a doctor's button press from the automatic
catch-up at close (the one that would otherwise rot unnoticed), `stage` is
`load` / `render` / `store`. **Ids and shape only** — never the patient's name or
phone, never the answers; the patient's name is scrubbed out of error *messages*
too, because a Postgres error quoting the generated filename would otherwise name
them. Expected outcomes (`NotFoundError`, `ConflictError` — "save the form first")
are not incidents and are never reported. The reporter itself can't throw.

Known trade-off: the message scrubber redacts anything phone-shaped, so a date or
a long id inside an error message may come back as `[redacted-number]`. That's the
safe direction to be wrong in.

### Still open from that audit
- **Concurrent `createConsultation` can still fork a visit** (two rows, same
  visit number) if two creates are genuinely simultaneous — the UI can no longer
  send them, but the API can be driven that way from two tabs. Enforcing it
  properly means a partial unique index (`"clientId" WHERE status = 'open'`),
  which Prisma can't express in `schema.prisma` and would report as drift, or
  locking the client row inside the create transaction.

---

## 14. Jessy — the third-party payer and its receivable ledger

Jessy is a **prepaid / third-party payer**: the patient settles their visit
through Jessy, and Jessy later transfers that money to the clinic. It is a normal
payment method (`jessy` in `PAYMENT_METHOD_VALUES`, so it works everywhere the
others do, including split settlements), plus a receivable ledger on top.

### The accounting rule (the whole point)

Income is recognized **immediately**, not when Jessy pays. A `$600` visit paid
`$400` through Jessy and `$200` deferred produces:

| | |
|---|---|
| Payment row, method `jessy` | **$400** — counted in income and in the method breakdown *today* |
| `ClientDebt` | **$200** — normal patient debt, exactly as before |
| `JessyReceivable` | **$400** — what Jessy now owes the clinic |

The patient does **not** owe the Jessy portion, and there is never a `$600` or
`$400` patient debt. Patient debt stays completely independent of payment method
— nothing about `ClientDebt` changed.

Three figures that must never be added together or conflated:

- **Jessy income volume** — what patients paid through Jessy. Already income.
- **Jessy outstanding** — what Jessy has not transferred yet. A *balance*, never
  windowed by a reporting period, and never part of any income figure.
- **Jessy settlements received** — collection of an existing receivable. **Not
  income.** Recording it as income would double-count money already reported.

`recorded − settled === outstanding` is asserted as an invariant in the tests.

### Where the receivable is created

Inside `createPayment` (`src/server/repositories/payments.ts`) — the single place
every `Payment` row is written, and already the home of the equivalent card-
surcharge rule. It is built as a **nested Prisma create**, so the payment and its
receivable are written in one statement: a `jessy` payment can never exist
without its receivable or vice versa, whether `createPayment` runs standalone
(manual payment) or inside a caller's transaction (basket settlement, debt
clear). This is also why clearing an old patient debt *through* Jessy correctly
raises a new receivable — it goes through the same chokepoint.

The receivable ledger is kept in **USD**, converted at the rate frozen on its own
payment. The native amount/currency is one join away on that `Payment`, so
nothing is lost; single-currency is what lets the allocator work without per-row
currency maths.

### Settlement (`recordJessySettlement`)

Applies money received from Jessy to the outstanding receivables **oldest first
(FIFO)**, creating no `Payment` and no income. Partial settlements are supported;
each transfer records a `JessySettlement` plus one `JessySettlementAllocation`
per receivable it touched, which is what makes the history auditable down to the
originating visit.

Safety, all inside one transaction:

- Each draw-down is a conditional `updateMany` guarded on `remaining >= portion`,
  so the WHERE and the decrement are one atomic UPDATE. Two settlements racing
  the same balance serialize on the row lock; the loser re-evaluates the guard,
  matches zero rows, and gets a readable `ConflictError` — **never a raw Prisma
  error and never a negative balance**.
- Over-settlement is refused up front against the live outstanding total (refused,
  not clamped — a typo must not invent a credit).
- An optional `idempotencyKey` makes a double-submitted transfer apply once.
- **Postgres CHECK constraints** (`remaining BETWEEN 0 AND amount`, positive
  amounts) are the last line of defence: even a direct write bypassing the
  repository aborts rather than corrupting the balance. They're hand-written in
  the migration — Prisma has no schema syntax for CHECK, so **`prisma migrate
  dev` will not recreate them if you ever squash migrations.**

### Deliberately not built

- **No void / refund / reversal.** The clinic does not refund patients, and the
  app has no payment-void concept anywhere (a paid visit already refuses deletion
  — *"payments are never refunded"*). So there is no "reverse a Jessy receivable"
  action. A receivable disappears only with its payment, via the existing
  `onDelete: Cascade` from `Payment` (and from `Client`). If a correction path is
  ever wanted, it must decide what happens to the already-recognized income — see
  the note in §6 above about that trade-off.
- **Jessy is hidden on the Expenses form** (`EXPENSE_PAYMENT_METHOD_VALUES`).
  It's a channel the clinic collects *through*, never one it spends from. The
  expense `method` field is still a loose `z.string()` server-side, matching the
  existing behavior — the exclusion is the dropdown, not a new server rule.
- **No per-patient "Jessy owes for you" view.** The receivable is the clinic's
  claim on Jessy, not on the patient, so it deliberately does not appear as
  anything the patient owes on their profile.

### Ledger protection (database triggers)

The ledger must always satisfy `recorded − settled = outstanding`. The repository
upholds it, but money invariants have to survive what the repository never sees:
a raw SQL fix, a Prisma Studio edit, a future `payment.delete()`, or a cascade
from a client-delete added later. The `protect_jessy_ledger` migration installs
triggers that refuse:

- deleting a receivable Jessy has **already settled against** — which also blocks
  deleting its parent `Payment`, and any `Client` cascade reaching it (a cascade
  performs a real DELETE on the child, so the trigger fires). An **unsettled**
  receivable still deletes freely with its payment; the guard protects balances,
  it doesn't freeze untouched rows.
- raising a receivable's `remaining` (there is no reversal, so a balance moving
  up is always corruption), editing its frozen `amount`, moving it to another
  payment, or reopening a settled one.
- deleting or re-pricing a recorded `JessySettlement`.
- changing or deleting a `JessySettlementAllocation` — append-only audit trail.

`handleError` (`src/server/http.ts`) extracts the trigger's message from the
Prisma error and returns it as a **409 with the guard's own sentence**, so a
blocked write never surfaces as an opaque 500. `deleteConsultation` additionally
refuses a visit carrying a receivable with a readable message before the DB is
ever reached (the paid-basket guard normally fires first — the Jessy check is the
second line, tested on its own).

**These triggers are hand-written SQL.** Prisma cannot express them, does not
introspect them, and `migrate dev` will not recreate them if migrations are ever
squashed — same caveat as the CHECK constraints.

**TRUNCATE does not fire row triggers**, which is the one sanctioned way to reset
a protected ledger; `resetJessyLedger()` in `tests/race/harness.ts` uses it, and
it must run *before* any client/payment delete whose cascade would be blocked.

### Permissions — admin-only, both sides

Everything Jessy is **admin-only**, via `canManageJessy` (`src/server/auth.ts`):
`GET /api/jessy`, `POST /api/jessy/settlements`, and the nav item.

This is deliberately stricter than `canHandleMoney`. Every figure on the ledger
is an aggregate of income and outstanding balance, and the permission matrix
(docs/01-product-spec.md §2.1) puts financial reports at admin-only — *"the
secretary sees all clients but never financial reports."* Recording a transfer is
a back-office reconciliation **against a balance the secretary may not see**, so
granting the write without the read would have been incoherent. An earlier draft
had the write on `canHandleMoney` while the page was admin-only; that mismatch is
resolved in favour of the matrix, not against it.

Audited actions: `Jessy payment recorded` (written even when the generic payment
audit is suppressed, e.g. a debt cleared through Jessy) and `Jessy settlement
recorded`. Neither logs patient names — receipts and amounts only.

### Tests

`tests/race/t14-jessy.ts` (run with `npm run test:race`). Covers the basic
$600/$400/$200 flow, a fully-Jessy visit, a cash+Jessy+debt split, partial then
full settlement with "no new income" assertions, refused over-settlement, two
concurrent settlements racing one balance, double-submitted Jessy payments
(sequential and concurrent) yielding one receivable, transaction rollback leaving
no orphan payment or receivable, the DB CHECK constraints firing, FIFO ordering
across a mixed ledger, and regressions for cash / card (surcharge intact) /
whish / omt / patient debt clearing.

It also covers ledger protection (nine delete/edit attacks blocked, the ledger
byte-for-byte unchanged afterwards, the 409 translation) and permissions, driven
through the **real route handlers with real session cookies** — admin allowed,
secretary/dietitian/unauthenticated/forged-session all refused on both read and
write, with the refusal leaking no ledger data.

---

## 15. Multi-currency tender (USD / EUR / LBP) against USD bills

### The accounting rule (the whole point)

> **Obligations are denominated in USD. Payments may be tendered in USD, EUR or LBP.**

A $1,000 visit is a $1,000 visit however it is paid. A $400 debt stays a $400
debt even when it is later settled with €368. Nothing in this feature makes a
bill, a basket, a session plan, a package price or the Jessy ledger foreign —
only the `Payment` row (the money physically handed over) carries a tender
currency. That distinction is enforced in the type system: `Currency`
(`lib/types.ts`) is the denomination of an *obligation* and is still
`"USD" | "LBP"`; `TenderCurrency` (`lib/money.ts`) is `"USD" | "EUR" | "LBP"`
and appears only on payments. **Do not widen `Currency`** — doing so would turn
this into a foreign-currency accounting system, which is out of scope and would
put FX exposure onto debts the clinic cannot hedge.

### Rate direction, stated once

```
fxRate = units of the tender currency per 1 USD
USD equivalent = native amount / fxRate
```

USD → 1, EUR → ~0.92, LBP → ~89,500. Everything goes through `fxRateFor` /
`tenderToUsd` in [`src/lib/money.ts`](../src/lib/money.ts) so the direction can
never be inverted at a call site.

### Where the rate is frozen

`Payment.fxRate` — resolved **server-side from Settings inside the settlement
transaction** and written with the payment. `amountPaid / fxRate` is that row's
USD value forever. Every report, dashboard figure and drill-down reads it via
`paymentUsd`, never today's Settings, so an admin editing the rate cannot
re-price yesterday. A rate is **never accepted from the client** — there is no
input field for one, and the Zod schemas strip unknown keys, so a crafted
request carrying `fxRate` or a pre-computed `amountUsd` is silently discarded
and the server converts with its own rate.

`Payment.usdToLbp` is untouched and still means exactly what it always did.
Rows written before this feature have `fxRate = NULL` and are valued through
that snapshot (`frozenPaymentFxRate`) — which is what makes the change
behaviour-preserving for existing data. **`usdToLbp` was deliberately NOT
renamed to a generic `fxRate` across the five models that carry it** (Payment,
VisitBasket, ClientDebt, SessionPlan, Expense — 80+ call sites): the rename
would have touched every financial read path for no behavioural gain, since
only `Payment` can ever hold foreign tender. Migration safety beat aesthetic
purity here.

### Fail-closed conversion

`toUsd` used to be `currency === "LBP" ? amount / rate : amount` — **anything
that wasn't LBP was silently treated as already-USD**, and `asCurrency` mapped
any unrecognised string to `"USD"`. Both now throw. That was harmless while only
USD and LBP existed and would have become a revenue misstatement the moment a
EUR row appeared. If you add a currency, add it to the exhaustive switch in
`fxRateFor` — the compiler will point at every place that needs a decision.

### Rounding and the settlement tolerance

- Each leg is converted and rounded to the cent **exactly once**, in
  `tenderToUsd`. Callers must not re-round the result.
- The settlement check is `|Σ legUsd − amountDue| ≤ tolerance`, where
  `tolerance = 0.005 × (1 + number of non-USD legs)`.
- **A USD-only settlement keeps the original half-cent epsilon exactly**, so no
  cent-level underpayment can slip through on the path virtually every
  settlement takes. Each converted leg buys precisely the half-cent its own
  rounding can introduce, and no more. It is *not* widened because LBP amounts
  are large — the size of the native amount is irrelevant, only the number of
  conversions is. A full cent short is refused (see the tolerance test in t16).

### Card surcharge is calculated natively, not in USD

`createPayment` applies the percentage in the payment's **own** currency. A
percentage commutes with conversion, so this is economically identical to
computing in USD and converting — but it rounds once instead of twice and
preserves this table's existing invariant that `cardSurchargeAmount` is a
portion of `amountPaid` in the same unit. Don't "fix" it by converting back
and forth.

### Method × currency is the leg identity

Split settlement folds duplicates on `method|currency`, **not** method alone.
"Cash / USD $100" and "Cash / EUR €200" are two economically distinct legs of
one settlement; folding on method would destroy a native amount and mis-state
the drawer. Each leg becomes its own `Payment` row with its own receipt number.

### Jessy stays USD-only

Rejected in three places: the Zod schema, `createPayment` (the chokepoint every
Payment goes through), and the UI's currency picker. FIFO allocation across
receivables is only sound in a single unit — see §14. **Do not generalise it**
without redesigning the ledger.

### Client debts: USD principal, partial collection

`ClientDebt.paidAmount` (USD) was added so a debt can be *part*-paid. This is
not a convenience: foreign tender rarely lands on the exact balance (€200
against a $400 debt is $182.61), so without it the desk would have to fake an
exact amount. Outstanding = principal (in USD) − `paidAmount`. Overpayment is
**refused, not clamped** — the app has no credit-balance or refund concept
anywhere, so inventing one here would create money it can never pay back.
Both the partial and the full path move the row with a conditional `updateMany`
guarded on the `paidAmount` it was read at, so two concurrent collections can
never both apply to a stale balance.

### Hand-written SQL that Prisma cannot express

The `20260813150000_multi_currency_tender` migration adds CHECK constraints —
`Payment.currency IN ('USD','EUR','LBP')`, `fxRate > 0`, EUR requires a rate,
`ClientDebt.currency IN ('USD','LBP')`, `0 ≤ paidAmount ≤ amount + 0.005`.
Like the Jessy ledger's, **these are invisible to Prisma introspection — don't
lose them if migrations are ever squashed.**

### Tests

[tests/race/t16-multi-currency-tender.ts](../tests/race/t16-multi-currency-tender.ts)
via `npm run test:race` — 65 assertions covering the USD regression path, the
worked mixed-currency example, rate freezing across a rate change, method ×
currency distinctness, under/over-payment, the tolerance boundary, crafted-input
rejection, Jessy, card surcharge in three currencies, debt partial collection,
concurrent settlement, and the DB constraints.

---

## 16. FX governance: stale rates, suspicious rates, rate history, receipts

Second-pass hardening on top of §15. Read that first — this section assumes it.

### Stale rate at checkout

The settlement screen sends `expectedRates` (the rates it was displaying) with the
split. The server values everything with its OWN rates regardless — `expectedRates`
is **advisory and never used to value anything** — and compares. If a rate the
settlement actually uses has moved, the whole settlement is rejected with
`StaleFxRateError` (409, `code: "fx_rate_stale"`) and nothing is written.

Silently re-pricing would be worse than useless: the desk would collect the €368 it
was shown while the system booked a different USD value, and the patient would walk
away short. Only currencies the settlement *uses* are checked, so an LBP rate
change can't block a USD+EUR payment. A forged `expectedRates` can at worst refuse
its own settlement — it cannot move a single figure.

### Suspicious rate changes

Two layers. `FX_BOUNDS` (absolute) rejects the impossible and fires **first**.
`FX_SUSPICIOUS_RATIO` (relative) catches the plausible-looking order-of-magnitude
typo that absolute bounds cannot see — 0.92 → 92, 89,500 → 895.

Thresholds are per-currency **because the currencies are genuinely different**:
EUR is a floating major pair where 25% in one edit is already a huge correction;
LBP has a history of step re-pegs (1,507 → 15,000 → 89,500) where several hundred
percent is legitimate. Expressed as a max ratio in either direction so ×10 and ÷10
are treated as equally suspicious — a percentage would not be.

The confirmation is **not a bypass flag**. It carries the *value* being confirmed;
the server re-detects the suspicion from values it reads itself and honours the
acknowledgement only when the confirmed value equals the value being saved. Being
warned about 92 and then submitting 46 with the old confirmation attached warns
again.

### Rate change history

`FxRateChange` — append-only, one row per rate that actually **moves** (a no-op
re-save writes nothing, which matters because the Pricing form posts both rates
every time). Every field is server-derived: actor from the verified session,
`oldValue` read inside the same transaction, `changedAt` a database default. There
is no POST/PATCH/DELETE anywhere for it. Admin-only to read
(`GET /api/settings/fx-history`) and to write. A matching line also lands in the
shared `AuditLog` — the same dual-write pattern the Jessy ledger uses.

**`updateSettings` takes a transaction-scoped advisory lock**
(`pg_advisory_xact_lock`). Without it two concurrent edits both read the same
"before" under READ COMMITTED and both log it, so the history would show
0.92 → 1.00 and 0.92 → 1.10 for what was really 0.92 → 1.00 → 1.10 — a plausible
lie, which is worse than no history. `SELECT FOR UPDATE` can't be used: it cannot
lock a Setting row that doesn't exist yet (the first-ever set).

### Printable receipt

`GET /api/receipts/[paymentId]` renders on demand from persisted rows —
deliberately **not stored**, unlike the Food List PDF. A stored receipt would be a
second source of truth that could drift from the ledger and would need its own
staleness handling; one derived from the payment rows is guaranteed to agree with
them and is structurally incapable of re-pricing. Nothing in the receipt path reads
Settings.

Passing **any** leg of a split settlement yields the same complete receipt (legs
share a `visitBasketId`). Gated on `canHandleMoney`. USD-only receipts show no FX
at all; rate/equivalent lines appear per leg, only where a conversion happened.

### The settlement tolerance was WRONG in §15 and is now fixed

§15 scaled the tolerance by half a cent per converted leg. That was based on a
false premise and let a full cent of underpayment through on a single-EUR-leg
settlement (91.99 EUR against a $100 bill was accepted).

Every leg's USD value is `round2(native / rate)` and the amount due is `round2(…)`,
so **both sides of the comparison are whole numbers of cents and their difference
is always an exact multiple of $0.01** — there is no sub-cent residue to absorb.
The tolerance is now a flat `SETTLEMENT_EPSILON_USD = 0.005`, which exists purely
to forgive IEEE-754 noise (`99.99 - 100` evaluates to `-0.010000000000005`). A full
cent short or over now fails **by construction**, for USD-only and mixed alike.

### No historical FX fallback

`frozenPaymentFxRate` has **no fallback**: a payment that cannot be valued from its
own stored data throws, naming the receipt. Evidence this is safe: every revision of
`createPayment` in the repository's history writes `usdToLbp: await getUsdToLbp()`,
which is guarded to return a positive rate, so no payment the app has ever written
lacks one. The `Payment_valuable` CHECK
(`currency = 'USD' OR fxRate IS NOT NULL OR usdToLbp > 0`) makes it structurally
impossible going forward — and because `ADD CONSTRAINT` validates existing rows, a
database that *did* contain such a row fails the migration loudly at deploy time
instead of mis-valuing it. **That failure is the remediation signal: fix the row,
re-run.** No historical rate is ever guessed or backfilled.

### `formatMoney` now shows cents when they exist

`minimumFractionDigits: 0, maximumFractionDigits: 2` instead of a hard round to
whole units. Zero churn for round amounts ($12,450 is unchanged), but a $182.61
remaining debt no longer renders as "$183" — which had the desk trying to collect
$183 and being refused as over-payment. Use `formatUsd` where a trailing ".00" is
wanted as a signal of exactness (receipts, FX equivalents).

### Tests

`tests/race/t17-fx-governance-and-receipts.ts` (81 assertions) and
`tests/race/t18-adversarial-financial.ts` (80 assertions, driven through the real
route handlers with real session cookies).

---

## 17. Machine visits — attendance without a consultation

A patient who comes in only to use prepaid machine sessions is recorded as a
**machine visit** (`MachineVisit` + `MachineVisitItem`), not a consultation. The
point is front-desk speed: the doctor sees the patient, decides no consultation is
needed, logs the machines used, and the appointment closes out — no visit number,
no measurements, no notes, no consultation fee, no close/basket state machine.

### Why it isn't a `Consultation` with a flag

Everything that makes a consultation a consultation would have had to be
suppressed by that flag: `visitNumber`, the frozen consultation fee, the
basket/close sequence, `canViewClinical` gating, the Food List catch-up, the
delete guards — and `counts.consultations` on the dashboard would have silently
grown by every machine visit. It is also the first per-visit **consumption event**
in the app: before this, `SessionPlan.sessionsUsed` was a bare counter whose only
history was the consultation treatment rows behind it.

### Billing: none at all (superseded — see §18)

A machine visit used to top up whatever prepaid credit didn't cover, raising its
own basket. **It no longer bills anything.** It consumes `sessionsPaid −
sessionsUsed` and refuses when that is short. See §18 for the model that replaced
this and why.

### Appointment linkage — explicit beats inferred

`completeLinkedAppointmentTx` (the consultation path) completes **every** live
appointment the client has, matched by client and status. Machine visits do not
reuse it:

- Launched from the queue, the appointment id travels with the request and **that**
  row is completed — after checking it belongs to the patient (an id from a
  browser is never trusted).
- Launched from the client profile with no id, the visit auto-completes only when
  the patient has **exactly one** appointment in `checked_in`/`with_dietitian`.
  Two candidates or none leaves the visit unlinked rather than guessing.
- An explicit appointment that is cancelled/no-show is refused; one already
  completed is linked without being touched.

**The consultation path now works the same way** (`Consultation.appointmentId`,
added in `20260813190000_consultation_appointment_link`). It used to complete
*every* live appointment the patient had, so a patient booked twice in a day had
both closed out by one visit. A visit started from the queue records the booking
it is fulfilling (the id travels queue → profile → editor as `?appt=`) and closing
completes only that one. With no link the common case is preserved — a single live
appointment is completed — and two or more candidates complete none rather than
guess. A link for another patient's booking is refused.

One consequence worth knowing: an unlinked visit for a patient with two live
appointments now leaves both on the board for the front desk to resolve, where it
previously (wrongly) cleared both.

### Void, not edit

A mistake is voided, never rewritten: the row stays in history with who voided it,
when, and why; the sessions are given back exactly; the pending basket it raised is
deleted. **A machine visit whose basket has been settled cannot be voided** — the
app has no refund or payment-reversal concept anywhere and this doesn't introduce
one. A dietitian may void their own visit, an admin anyone's.

### Session counters are now one implementation

`repositories/sessionCounters.ts` is the only place `SessionPlan.sessionsUsed`,
`SessionPlan.sessionsPaid` and `ClientPackage.usedSessions` move, for both
consultations and machine visits. Every move is a single guarded SQL statement
computed by the database from the row's own value under its lock. This replaced a
read-then-write pair that could lose a consumption when two saves landed together,
and a `Math.min(totalSessions, …)` clamp that silently recorded fewer sessions
than were asked for (asking for 3 against a bundle with 1 left now fails).

`updateConsultation`/`deleteConsultation` additionally take the visit's row lock
(`SELECT … FOR UPDATE`) for the whole transaction. The counter writes were already
atomic, but the *read* of the treatment rows a rebuild reverses was not: two saves
of the same draft both read the pre-edit rows and left the plan over-consumed.
That was a real pre-existing bug, reproduced and now covered in t19.

### Constraints that are hand-written SQL (don't lose them in a squash)

In `20260813180000_machine_visits`: exactly-one-source and positive-sessions on
`MachineVisitItem`, `billedSessions ≤ sessions`, the status/void-attribution pair
on `MachineVisit`, non-negative counters on `SessionPlan`, and
`usedSessions ≤ totalSessions` on `ClientPackage`.

**`SessionPlan.sessionsUsed ≤ sessionsNeeded` is deliberately NOT a constraint.**
The consultation editor accepts more sessions delivered than the plan currently
calls for (`sessionsNeeded` is purchase intent, not a ceiling), so asserting it
would reject saves the app has always allowed. The machine-visit path enforces the
ceiling itself, in application code.

### Known limits

- **Voiding does not re-open the appointment it completed.** The patient did
  attend; un-completing a booking hours later would fight the queue's own state
  machine. Re-book if the completion was wrong.
- **The secretary can't see machine visits in the client's history** — the Visits
  tab is clinical-gated as before. She sees the basket, the payment and the
  receipt, which is what the front desk acts on.
- **Machine utilization counts consultation sessions from CLOSED visits only.**
  An open draft's counts change with every save and can be removed entirely, so
  reporting them would let the figure move without anything happening in the
  clinic. This is a reporting rule only — an open draft still consumes the plan's
  balance as it always did, and plans stay usable by later consultations and
  machine visits until their sessions run out. Machine visits are reported the
  moment they are logged (they have no draft state).
- **`MachineVisitItem` → plan/bundle FKs are `RESTRICT`.** Deleting a patient row
  directly in the database now fails while machine visits reference their plans.
  No application path deletes a client; `deleteConsultation` checks for
  machine-visit usage before dropping a plan an abandoned visit created.


## 18. Sessions are settle-before-use

The employee-facing rule is one line:

> Purchase sessions → settle by payment or debt → sessions become usable →
> machine visits only consume them.

### What the counters mean now

| column | meaning |
| --- | --- |
| `sessionsNeeded` | the **prescribed course length** — clinical intent ("this patient needs 13 sessions of Cryolipolysis"). It bills nothing by itself. |
| `sessionsPaid` | sessions **purchased AND settled**. This is the usable supply. |
| `sessionsUsed` | sessions delivered. |
| `available` | `sessionsPaid − sessionsUsed`, floored at 0. Derived, never stored. |

`sessionsPaid` was deliberately **not** renamed even though "settled" is now a
better word than "paid": every existing row's value is already correct under the
new reading, it is the column three financial paths write, and a rename would
have churned the schema for nothing.

### What replaced the old model

Before, a plan was a running account with an overdraft: `sessionsUsed` could
exceed `sessionsPaid`, and the unpaid gap lived **on the plan**. That is why
`settleVisitBasket` used to refuse a debt covering a session-plan line — the same
money would then have been tracked twice (once as the plan's gap, once as a
`ClientDebt`). Machine visits papered over the gap by billing the difference.

Now a purchase is a discrete event:

1. Sessions are sold as a basket line — from the consultation that prescribes the
   course, or from the standalone front-desk sale (`sellSessions`).
2. The basket is settled: **paid now, or the balance moved to a `ClientDebt`.**
   Both settle it, and both unlock identically.
3. `creditSessionPlanPaidTx` raises `sessionsPaid`. That is the unlock.

The unpaid money is therefore tracked in exactly one place — the `ClientDebt` —
and the plan carries no balance owed. Removing the debt cap was safe *because*
of that, not in spite of it.

### The one exception: the originating consultation

The visit that **prescribes** a course may also deliver from it before the patient
reaches the front desk (`limit: "prescribed"` in `consumeSessionPlanTx`, drawing
against `sessionsNeeded`). This is safe because `assertBasketSettledTx` refuses to
close a visit with an unsettled basket — every session a consultation delivers is
bought and settled by the time the visit is finalized. It is also why the CHECK
constraint asserts `sessionsUsed <= sessionsNeeded` and **not**
`sessionsUsed <= sessionsPaid`: `available` is briefly 0 (clamped, never negative)
between delivery and checkout.

Machine visits get `limit: "available"` and no exception.

### Not billing twice across two purchase routes

A front-desk top-up sale that is still pending is invisible to `sessionsPaid`, so
a consultation opened before it settles would have re-sold the same sessions.
`pendingPurchasedSessionsTx` is what prevents that: the billable quantity is
`sessionsNeeded − sessionsPaid − pendingOnOtherBaskets`.

**Do not express that exclusion as a Prisma `consultationId: { not: id }`
filter.** It compiles to SQL `<>`, which is NULL for a standalone sale basket
(`consultationId IS NULL`) and silently drops exactly the rows the function
exists to find. This was a real double-billing bug caught by
`t21-sessions-settle-before-use.ts`; the exclusion is applied in JS for that
reason.

### Debt forgiveness keeps the sessions

`voidClientDebt` touches no counter. Forgiving what a patient owes is the
clinic's choice; it does not repossess sessions they were sold. There is
correspondingly no path that unlocks twice — the unlock happens once, after the
conditional `pending → paid` flip, and a second settle attempt throws.

### Constraints that are hand-written SQL (don't lose them in a squash)

`20260813200000_sessions_settle_before_use`:

```sql
ALTER TABLE "SessionPlan"
  ADD CONSTRAINT "SessionPlan_bought_within_prescribed"
  CHECK ("sessionsPaid" <= "sessionsNeeded" AND "sessionsUsed" <= "sessionsNeeded");
```

Every write that lowers `sessionsNeeded` goes through `sessionPlanNeedsFloorTx`
(floor = bought + pending + delivered) and every write that raises `sessionsPaid`
lifts `sessionsNeeded` with it, so the CHECK is a backstop rather than a
constraint the application fights.

### Known limits

- **A mistaken standalone sale cannot be undone.** There is no "delete a pending
  basket" flow anywhere in this app, so a sale typed as 40 instead of 4 leaves a
  pending basket and a raised `sessionsNeeded`. Nothing is collected and nothing
  is unlocked (settlement is what unlocks), so it is a tidiness problem, not a
  financial one — but a cancel-sale flow is the obvious next addition.
- **A sale basket must be settleable away from the queue board.** The queue's
  Payment lane is scoped to `isToday`, so a sale made yesterday and not settled
  would be invisible there — the money uncollectable and the sessions never
  unlocked. The client profile's **Payments → To settle** card is the date-free
  way in; it is not a nicety. A sale basket carries `dietitianId: null` and no
  `consultationId` for the same reason: it belongs to no visit and no doctor.
- **Historic plans may sit with `sessionsUsed > sessionsPaid`.** Those predate the
  split and are left as they are; the migration only lifts `sessionsNeeded` to the
  floor so the CHECK can be applied. Such a plan simply has 0 available until more
  sessions are sold and settled.
- **`MachineVisitItem.billedSessions` / `MachineVisit.amountDue` are historic
  fields.** Always 0 on anything recorded since; kept because the money on older
  rows was really collected.

### Tests

`tests/race/t21-sessions-settle-before-use.ts` covers the whole rule: paid
unlocks, debt unlocks identically, pending unlocks nothing, double settle unlocks
once (including two racing settles), forgiveness keeps sessions, the originating
consultation exception, the standalone sale, no double billing across both
purchase routes, and the CHECK constraints. `t19-machine-visits.ts` covers the
refusal path; `t13-billing-rules.ts` is unchanged and still passes.
