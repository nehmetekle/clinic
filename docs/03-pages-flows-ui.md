# NutriClinic — Pages, User Flows & UI Layout

## 1. Navigation shell

Persistent left **sidebar** (collapses to a bottom tab bar / hamburger on mobile) +
top bar with global search, clinic/date, notifications, and the user menu.

**Role-specific sidebar:**

| Secretary | Dietitian | Admin |
|---|---|---|
| Dashboard (Queue) | Dashboard (Today's clients) | Dashboard (Overview) |
| Clients | My clients | Clients |
| Appointments | Appointments | Appointments |
| Today's Queue | Today's Queue | Today's Queue |
| Payments | Consultations | Packages |
| Expenses | Progress | Payments |
| Search | — | Expenses |
| | | Reports |
| | | Staff |
| | | Audit Log |
| | | Settings |

---

## 2. Page inventory

| # | Page | Route | Roles |
|---|---|---|---|
| 1 | Login | `/login` | all |
| 2 | Secretary dashboard | `/` (secretary) | secretary |
| 3 | Dietitian dashboard | `/` (dietitian) | dietitian |
| 4 | Admin dashboard | `/` (admin) | admin |
| 5 | Client list | `/clients` | sec, diet, admin |
| 6 | Add new client | `/clients/new` | sec, admin |
| 7 | Client profile | `/clients/:id` | sec, diet, admin (scoped) |
| 8 | Appointment calendar | `/appointments` | all |
| 9 | Today's queue | `/queue` | all |
| 10 | Consultation editor | `/clients/:id/consultations/new` `/consultations/:id` | diet, admin |
| 11 | Packages | `/packages` | admin (sec read) |
| 12 | Payments | `/payments` | sec, admin |
| 13 | Expenses | `/expenses` | sec, admin |
| 14 | Reports | `/reports` | admin |
| 15 | Staff management | `/staff` | admin |
| 16 | Settings | `/settings` | admin |
| 17 | Audit log | `/audit` | admin |

---

## 3. Dashboard layouts (wireframes)

### 3.1 Secretary dashboard — *fast daily work*
```
┌──────────────────────────────────────────────────────────────┐
│  [ + Add New Client ]   [ + Record Payment ]   [ + Add Expense ]│  ← primary actions
├───────────────────────────────┬──────────────────────────────┤
│  TODAY'S APPOINTMENTS (live)   │  CHECK-IN QUEUE               │
│  09:00 Sara K.  Follow-up  ▸   │  ● Sara K.   waiting  3m      │
│  09:30 John D.  Initial    ▸   │  ● John D.   with diet.       │
│  10:00 ...                     │  [ Check in next ]           │
├───────────────────────────────┼──────────────────────────────┤
│  RECENT PAYMENTS               │  QUICK SEARCH                │
│  RCP-...123  Sara  $50 paid    │  [ search name / phone... ]  │
└───────────────────────────────┴──────────────────────────────┘
```

### 3.2 Dietitian dashboard — *consultations*
```
┌──────────────────────────────────────────────────────────────┐
│  TODAY'S CLIENTS                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 09:00 │ Sara K. │ 3-Month Prog │ Follow-up │ ✅checked-in │  │
│  │       │ pkg 4/12 sessions       │ [Profile] [Start ▶]    │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ 09:30 │ John D. │ Initial Cons │ Initial   │ ⏳waiting    │  │
│  └────────────────────────────────────────────────────────┘  │
├───────────────────────────┬──────────────────────────────────┤
│  WAITING NOW (2)           │  FOLLOW-UP REMINDERS             │
│  Sara K. · John D.         │  Mia R. due 18 Jun · Tom due 20  │
├───────────────────────────┼──────────────────────────────────┤
│  RECENT CONSULTATIONS      │  PROGRESS SNAPSHOT (assigned)    │
│  Sara K. 12 Jun -1.2kg     │  avg weight change -3.4% / 30d   │
└───────────────────────────┴──────────────────────────────────┘
```

### 3.3 Admin dashboard — *business performance*
```
┌──────────── period: [Today][Week][Month][Custom]  filters ▾ ──┐
│ KPI CARDS                                                      │
│ [ Income $X ] [ Expenses $Y ] [ Net Profit $Z ] [ Unpaid $W ] │
│ [ Clients N ] [ New today n ] [ Active a ] [ Pkgs sold s ]    │
├───────────────────────────────┬──────────────────────────────┤
│  INCOME vs EXPENSES (line)     │  REVENUE BY PACKAGE (bar)    │
├───────────────────────────────┼──────────────────────────────┤
│  APPOINTMENTS BREAKDOWN (donut)│  STAFF ACTIVITY (table)      │
│  completed / cancelled / no-show│  diet: 14 consults · sec: 9 │
├───────────────────────────────┴──────────────────────────────┤
│  UNPAID BALANCES (table)        MOST POPULAR PACKAGE: ...      │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Client profile (the hub)

Tabbed page; tabs visible per role.

```
[ Avatar ] Sara Khalil · ☎ +961... · Active · Dietitian: Dr. Lara
Balance: $0 · Active pkg: 3-Month Program (4/12) · Next: 18 Jun 09:00
─────────────────────────────────────────────────────────────────
[Overview][Personal][Package][Appointments][Consultations][Measurements][Payments][Notes][Files]
```
- **Overview** — snapshot cards: status, active package + sessions, balance, next appt, weight change, last consult.
- **Personal** — editable demographics (secretary/admin).
- **Package** — current + historical client_packages, sessions used/remaining, payment status, [Assign package].
- **Appointments** — past + upcoming; [Schedule].
- **Consultations** — list of entries (date, dietitian, visit #, weight); open any to read; [Start consultation] (dietitian).
- **Measurements** — table + charts (weight, BMI, body comp over time).
- **Payments** — payment history + [Record payment] + receipts.
- **Notes** — general non-clinical notes.
- **Files** — attachments.

Tabs hidden from secretary: clinical content of **Consultations** & full **Measurements** detail (sees summary), per privacy boundary.

---

## 5. Consultation editor

Two-pane on desktop/tablet:
```
┌──── NEW CONSULTATION — Sara K. (Visit #5) ────┬──── PREVIOUS (Visit #4, 12 Jun) ───┐
│ Date [auto]  Dietitian [you]  Visit# [5 auto] │ Weight 71.2  BMI 25.1              │
│ Weight [__] kg   Height [__] cm  BMI [auto]   │ Goals: reduce sugar...            │
│ Waist[ ] Hips[ ] BodyFat[ ] Muscle[ ]         │ Notes: responding well...         │
│ Goal weight [__]                              │ Recommendation: +protein          │
│ Client goals [____________]                   │ ── compare ──                     │
│ Notes [__________________]                    │ Δ weight: -1.4 kg                 │
│ Recommendations [_________]                   │                                   │
│ Follow-up plan [_________]  Next appt [date]  │                                   │
│ Attachments [+]                               │                                   │
│ [ Save draft ]  [ Save & complete visit ]     │                                   │
└───────────────────────────────────────────────┴───────────────────────────────────┘
```
"Save & complete visit" → consultation saved, appointment → completed, package session decremented (transaction), client progress recomputed.

---

## 6. Core user flows

### Flow 1 — New client registration
```
Add New Client → fill info → select package → record payment (paid/partial/unpaid)
→ schedule first appointment → client saved + appears in DB and appointment list.
```
One multi-step form (or wizard: Info → Package → Payment → Appointment) committed in a single transaction so a half-saved client never exists.

### Flow 2 — Client arrives & is seen
```
Secretary: Today's Appointments → [Check in] (status→checked_in→waiting)
→ Client shows in Dietitian's "Today's Clients"
→ Dietitian [Start consultation] (status→with_dietitian)
→ writes notes + measurements → [Save & complete]
→ appointment→completed · package remaining −1 · progress updated.
```

### Flow 3 — Follow-up consultation
```
Dietitian opens client → Consultations tab → reviews previous (compare pane)
→ adds new measurements + notes → save → timeline + charts update.
```

### Flow 4 — Expense recording
```
Add Expense → title, amount, category, date (+receipt) → save
→ appears in admin reports → net profit recalculates.
```

### Flow 5 — Admin performance review
```
Admin dashboard → see income/expenses/profit, clients, package sales
→ apply filters (date/dietitian/package/method/status)
→ review staff activity → export report.
```

---

## 7. Component & UI conventions
- **Cards** for KPIs; **tables** (sortable, paginated, filterable) for lists; **forms** with inline validation; **charts** for trends.
- **Status pills** with consistent colors: scheduled (gray), checked-in (blue), waiting (amber), with-dietitian (purple), completed (green), cancelled (red), no-show (dark red); payment paid (green) / partial (amber) / unpaid (red).
- **Empty states** with a primary CTA ("No clients yet — Add your first client").
- **Toasts** for save/confirm; **confirm modals** for destructive actions.
- **Skeleton loaders** for dashboards/tables.
- **Currency/date** formatted from clinic settings.
- Mobile: primary actions become a floating action button; tables collapse to cards.

## 8. Global search & filter UX
- Top-bar search → unified results grouped by Clients / Appointments / Payments.
- Client list filter chips: Today · Active · Inactive · Unpaid · Completed packages · Upcoming appts · Missed appts · Has remaining sessions · Expired packages.
- Filters are URL-encoded (shareable, back-button friendly).
