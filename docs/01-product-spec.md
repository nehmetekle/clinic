# NutriClinic — Product Specification

A clinic operating system for a nutrition / dietitian practice. It connects the
**secretary's front-desk work**, the **dietitian's consultations**, and the
**owner's business reporting** into one continuous workflow.

---

## 1. Product summary

| Item | Decision |
|---|---|
| Product name (working) | NutriClinic |
| Type | Multi-role, single-clinic web application (multi-tenant-ready) |
| Primary users | Secretary/Receptionist, Dietitian, Admin/Owner |
| Platforms | Responsive web (desktop / tablet / mobile) |
| Visual style | Clean, modern, "medical SaaS" — calm palette, lots of white space, large tap targets |
| Core promise | Front desk → consultation → money, in one place, with no double data entry |

### Design principles
1. **No re-typing.** Data entered once (by the secretary) flows to the dietitian and admin.
2. **Role-shaped UI.** Each role sees a dashboard built around its daily job, not a generic menu.
3. **Fast front desk.** The two most common actions — *Add client* and *Check in* — are never more than one click from the secretary's home.
4. **Auditable.** Every money/clinical/permission action is logged with who + when.
5. **Mobile-real.** A dietitian can run a full consultation from a tablet at the desk.

---

## 2. Roles & permissions (RBAC)

Permissions are enforced on the **server** (every API call), not just hidden in the UI.

### 2.1 Permission matrix

| Capability | Secretary | Dietitian | Admin |
|---|:--:|:--:|:--:|
| Log in / change own password | ✅ | ✅ | ✅ |
| Create / edit client profile | ✅ | ✏️ basic only | ✅ |
| Search clients | ✅ | ✅ (own + assigned) | ✅ |
| Assign package to client | ✅ | ❌ | ✅ |
| Schedule / reschedule appointment | ✅ | ✅ (own) | ✅ |
| Check-in / manage daily queue | ✅ | ✅ (status only) | ✅ |
| Record payment | ✅ | ❌ | ✅ |
| Record expense | ✅ | ❌ | ✅ |
| Start / write consultation | ❌ | ✅ | ✅ (view) |
| View consultation clinical notes | ❌* | ✅ | ✅ |
| View client measurements/progress | summary only | ✅ | ✅ |
| Create / edit packages | ❌ | ❌ | ✅ |
| Manage staff users & roles | ❌ | ❌ | ✅ |
| View financial reports (income/profit) | ❌ | ❌ | ✅ |
| View audit log | ❌ | ❌ | ✅ |
| Export / backup data | ❌ | ❌ | ✅ |
| Settings (clinic-wide) | ❌ | ❌ | ✅ |

> \* The secretary sees a client's *non-clinical* summary (package, sessions, payment status, appointment), **not** medical notes, allergies detail, or consultation clinical content beyond what's needed for scheduling. This is the key privacy boundary. (Configurable in Settings if the clinic wants the secretary to see medical alerts.)

Legend: ✅ full · ✏️ limited · ❌ none.

### 2.2 Data-scope rules
- **Dietitian** sees clients **assigned to them** plus any client on **their** day's queue. Admin can grant "see all clients."
- **Secretary** sees all clients but **never** financial reports or another staff member's account settings.
- **Admin** sees everything.

---

## 3. Feature areas

### 3.1 Authentication & access
- Secure login with **email or username + password**.
- Passwords hashed with **Argon2id** (or bcrypt cost ≥ 12).
- Session via httpOnly, SameSite cookies; short-lived access + rotating refresh, or server sessions.
- Role-based redirect after login (Secretary → queue, Dietitian → today's clients, Admin → overview).
- Forgot-password (email link) + admin-initiated password reset.
- Optional **2FA (TOTP)** for admin — ✅ implemented (Settings → "Two-factor authentication").
- Auto-logout after inactivity (configurable, default 30 min) — important for shared front-desk machines.

### 3.2 Clients
- Create / view / edit / soft-delete (status = cancelled).
- Fields: first name, last name, phone, email (opt), DOB **or** age, gender (opt), address (opt), emergency contact (opt), medical notes (opt), allergies/restrictions (opt), assigned dietitian (opt), status (active / inactive / completed / cancelled), registration date (auto), created_by (auto).
- Derived: full name, current age (from DOB), active package, sessions remaining, outstanding balance, next appointment.
- **Client profile** is the hub — see tabbed layout in `03-pages-flows-ui.md`.

### 3.3 Packages (catalog)
- Admin-managed catalog: name, description, price, number_of_sessions, duration (days/weeks), discount (opt), status (active/inactive).
- Cannot be hard-deleted if referenced — deactivate instead (keeps history intact).
- Seed examples: Initial Consultation, Follow-up Session, Monthly Package, 3-Month Program, Premium Nutrition Plan.

### 3.4 Client packages (purchased instances)
- A snapshot of catalog data at purchase time (name + price copied so later catalog edits don't rewrite history).
- Tracks: total_sessions, used_sessions, remaining_sessions (derived), payment_status, start_date, expiration_date (opt), status.
- `remaining = total − used`. `used` increments when a consultation tied to that package is completed.
- A client may hold **multiple** packages over time; the "active" one is the current default for consultations.

### 3.5 Appointments & daily queue
- Schedule with client, dietitian, date, start/end time, visit_type (initial / follow-up / measurement-only / other), notes.
- Status lifecycle: `scheduled → checked_in → waiting → with_dietitian → completed` plus `cancelled` and `no_show`.
- **Today's queue** view: live board the secretary drives (check-in) and the dietitian consumes ("Today's Clients").
- Conflict warning when double-booking a dietitian.
- Calendar view (day / week / month) with drag-to-reschedule.

### 3.6 Consultations (clinical record)
- Started from the queue ("Start consultation") — client + appointment pre-linked, basic info pre-filled.
- One immutable-ish entry per visit (edits tracked in audit log).
- Fields: consultation_date, dietitian, visit_number (auto = count+1), weight, height, **BMI (auto)**, waist (opt), hips (opt), body_fat_% (opt), muscle_mass (opt), goal_weight (opt), client_goals, notes, recommendations, follow_up_plan, next_appointment_date (opt), attachments (opt).
- On **save + appointment completed** → package `used_sessions += 1`, appointment → completed, progress timeline updated.
- "Compare to previous": side-by-side of last consultation's measurements + notes while writing the new one.

### 3.7 Progress tracking
- Per client: starting weight, current weight, weight change (abs + %), goal weight, % to goal, sessions completed/remaining, BMI trend, consultation timeline.
- Charts: weight over time, BMI over time, body composition (fat/muscle) over time.

### 3.8 Payments
- Record at purchase or per session: client, package/service, amount_paid, total_amount, remaining_balance (derived), payment_method (cash/card/bank_transfer/online/other), payment_date, payment_status (paid/partially_paid/unpaid), receipt_number (auto), notes, created_by.
- Auto **receipt number** (e.g. `RCP-2026-000123`) + printable/PDF receipt.
- A client package's `payment_status` reflects the sum of its payments vs price.

### 3.9 Expenses
- Record clinic costs: title, amount, category (rent / utilities / salaries / supplies / marketing / equipment / maintenance / other), date, paid_by, payment_method, receipt_attachment (opt), notes, created_by.
- Categories are configurable in Settings.

### 3.10 Reports & analytics (Admin)
- KPI cards, tables, and charts (see admin dashboard layout).
- Financials: total income, total expenses, net profit; daily/weekly/monthly income & expenses; profit by period; unpaid balances; most profitable packages.
- Operations: total/new/active/inactive clients; today's appointments; completed/cancelled/no-show; packages sold; most popular package; dietitian & secretary activity.
- **Filters:** today / this week / this month / custom range / by dietitian / by package / by payment method / by client status.
- Export to CSV / PDF.

### 3.11 Staff management (Admin)
- Create staff, assign role, edit info, activate/deactivate, reset password, fine-tune permissions.
- Fields: full name, email, phone, role, status, created_at, last_login.
- Deactivated users keep their historical attribution (created_by stays valid) but cannot log in.

### 3.12 Global search & filters
- Search clients by name / phone / email / package / appointment date / payment status / assigned dietitian.
- Saved/quick filters: today's clients, active, inactive, unpaid, completed packages, upcoming appointments, missed appointments, clients with remaining sessions, clients with expired packages.

### 3.13 Audit log (Admin)
- Append-only record of: client create/edit, payment recorded, expense added, consultation create/edit, package change, staff/permission change, login events.
- Fields: user, action, entity_type, entity_id, timestamp, details (JSON diff/snapshot).

### 3.14 Attachments / files
- Expense receipts and client files (lab results, meal plans, photos).
- Stored in object storage; DB holds metadata + reference. Access checked by role.

### 3.15 Automatic calculations (single source of truth)
- **BMI** = weight(kg) / (height(m))².
- **Remaining sessions** = total − used.
- **Total income** = Σ payments.amount_paid (period-filtered).
- **Total expenses** = Σ expenses.amount (period-filtered).
- **Net profit** = income − expenses.
- **Unpaid balance** (client) = Σ(package price) − Σ(payments for that client).
- **Age** = today − DOB.
- **% to goal** = (start − current) / (start − goal).

---

## 4. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Dashboard + queue load < 1.5s on clinic wifi; search results < 500ms. |
| Responsiveness | Usable from 360px (phone) to 1920px; queue & consultation forms are tablet-first. |
| Accessibility | WCAG 2.1 AA: keyboard nav, labels, contrast, focus states. |
| Security | See `01` §3.1 + `04` security section; least-privilege RBAC enforced server-side. |
| Privacy | Health data treated as sensitive; encrypted at rest + in transit; role-scoped access; audit trail. |
| Reliability | Daily automated DB backup + on-demand export. |
| i18n-ready | Strings externalized; date/number/currency locale-aware (clinic currency configurable). |
| Browser support | Latest Chrome, Safari, Edge, Firefox; iOS/Android mobile browsers. |

---

## 5. Glossary
- **Visit type** — purpose of an appointment (initial, follow-up, measurement-only).
- **Client package** — a purchased instance of a catalog package, with its own session counters.
- **Queue** — today's live board of clients moving from check-in to completed.
- **Net profit** — income − expenses for the selected period.
