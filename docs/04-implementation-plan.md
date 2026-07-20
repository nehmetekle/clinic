# NutriClinic — Implementation Plan

## 1. Recommended tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router) + React + TypeScript** | One codebase for UI + API (route handlers / server actions); SSR for fast dashboards; great mobile/responsive story. |
| Styling / UI | **Tailwind CSS + shadcn/ui** | Clean medical-SaaS look fast; accessible primitives; easy theming. |
| Charts | **Recharts** (or Tremor for dashboards) | Simple, responsive KPI charts. |
| Data fetching | **TanStack Query** + server actions | Caching, optimistic queue updates. |
| Forms | **React Hook Form + Zod** | Shared validation schema client + server. |
| ORM / DB | **Prisma + PostgreSQL** | Type-safe schema; matches `02-database-schema.md`; migrations. |
| Auth | **Auth.js (NextAuth) credentials** + Argon2 + RBAC middleware | Sessions, role redirect; or Lucia if you want full control. |
| Files | **S3-compatible storage** (AWS S3 / Cloudflare R2 / MinIO for dev) | Receipts & client files; signed URLs. |
| Background jobs | **node-cron / a queue** | Expiry sweep, nightly backup, reminders. |
| Testing | **Vitest + Playwright** | Unit + end-to-end (the 5 core flows). |
| Deploy | **Vercel + Neon/Supabase Postgres**, or **Docker Compose** on a VPS | Pick per ops comfort. |

> Alternatives if you prefer a split stack: **NestJS/Express API + React (Vite)** front end. Same schema and flows apply. If you want zero-backend-ops, **Supabase** (Postgres + Auth + Storage + RLS) can replace several rows above — RLS is a natural fit for the role-scoping rules.

## 2. Architecture
```
Browser (React/Next, responsive)
   │  server actions / REST under /api
Next.js server  ── RBAC middleware (session → role → permission check)
   │  service layer (business rules: sessions, receipts, BMI, audit)
Prisma ── PostgreSQL  ──  Object storage (files)
   │
Cron jobs (expiry, backups, reminders)
```
- **Service layer** owns every invariant from `02 §Key integrity rules`. Routes are thin; services run transactions and write audit rows in the same transaction.
- **Authorization** centralized: a `can(user, action, resource)` policy module used by both API guards and UI gating (so the menu and the server agree).

## 3. Build phases (milestones)

**Phase 0 — Foundation (project setup)**
Repo, Next.js + TS + Tailwind + shadcn, Prisma schema + migrations, seed script (1 admin, sample packages), CI, env config, base layout/sidebar shell.

**Phase 1 — Auth & RBAC**
Login (email/username + password), Argon2 hashing, sessions, role redirect, route middleware, `can()` policy module, inactivity logout. *Exit:* each role lands on its dashboard; protected routes reject wrong roles (server-side).

**Phase 2 — Clients & packages**
Client CRUD + profile shell + tabs; package catalog (admin); assign client_package; client list with search + filter chips. *Exit:* Flow 1 minus payment.

**Phase 3 — Appointments & queue**
Scheduling, calendar (day/week), today's queue board, status lifecycle, check-in. *Exit:* Flow 2 up to "with dietitian."

**Phase 4 — Consultations & progress**
Consultation editor with compare pane, BMI auto, session decrement transaction, measurements + progress charts, consultation history. *Exit:* Flows 2 & 3 complete.

**Phase 5 — Payments & expenses**
Payment recording + receipt numbers + printable receipt; expenses + attachments; client balance. *Exit:* Flows 1 (full) & 4.

**Phase 6 — Admin reports & analytics**
KPI cards, charts, filters (date/dietitian/package/method/status), exports, staff-activity. *Exit:* Flow 5.

**Phase 7 — Staff, settings, audit**
Staff management (create/role/activate/reset), clinic settings, audit log viewer, audit writes wired across all mutations.

**Phase 8 — Hardening & launch**
Security review, accessibility pass, backups/export, e2e tests for all 5 flows, seed/demo data, deployment, docs/handoff.

> Suggested order to get something usable fastest: **0 → 1 → 2 → 3 → 4** gives a working secretary-to-dietitian loop; payments/reports (5–6) make it a business tool.

## 4. Security & privacy checklist
- [ ] Passwords: Argon2id (or bcrypt ≥ 12); never logged; reset tokens single-use + expiring.
- [ ] Sessions: httpOnly + Secure + SameSite cookies; CSRF protection on mutations; inactivity timeout.
- [ ] **Server-side RBAC** on every endpoint (UI hiding is not security).
- [ ] Data-scope checks (dietitian → assigned/queue clients only).
- [ ] Financial endpoints/reports admin-only.
- [ ] Clinical notes & allergies treated as sensitive; secretary gated by `secretary_sees_medical` setting.
- [ ] Encryption in transit (HTTPS) + at rest (DB + storage); consider column encryption for medical_notes/allergies.
- [ ] Input validation with Zod on both sides; parameterized queries (Prisma) — no string SQL.
- [ ] File upload: validate type/size, store outside webroot, serve via signed URLs, scan if possible.
- [ ] Rate-limit login; lockout/backoff on repeated failures; optional 2FA for admin.
- [ ] Audit log append-only; no UI to edit/delete it.
- [ ] Automated daily backups + tested restore; admin export (CSV/JSON).
- [ ] Secrets in env/secret manager, not in repo.
- [ ] Principle of least privilege for the DB user the app runs as.

## 5. Testing strategy
- **Unit:** BMI, session decrement, balance/receipt generation, `can()` policy matrix.
- **Integration:** transaction integrity (complete consultation → session −1; payment → status recompute).
- **E2E (Playwright):** the 5 flows, plus RBAC negatives (secretary blocked from reports, dietitian blocked from another's clients).
- **Seed/demo data** for manual UAT with the clinic.

## 6. Suggested repo structure (Next.js)
```
/app            route groups: (auth)/login, (app)/dashboard, clients, appointments,
                queue, consultations, packages, payments, expenses, reports, staff,
                settings, audit  + /api route handlers
/components     ui/ (shadcn), charts/, tables/, forms/, layout/(sidebar, topbar)
/lib            auth/, rbac/ (can.ts, policies), services/ (clients, packages,
                appointments, consultations, payments, expenses, reports, audit),
                db (prisma client), validation/ (zod schemas), utils (bmi, money, dates)
/prisma         schema.prisma, migrations, seed.ts
/jobs           expiry-sweep, backup, reminders
/tests          unit, e2e
```

## 7. Open decisions for you
1. **Stack:** confirm Next.js full-stack (recommended) vs split API, vs Supabase.
2. **Hosting:** Vercel + managed Postgres vs Docker on a VPS (data-residency / cost).
3. **Currency & timezone**, and whether the clinic wants the **secretary to see medical alerts**.
4. **SMS/email reminders** in v1 or v2 (needs a provider + budget).
5. **Single clinic now**, but should the schema stay **multi-clinic-ready**? (Easy to add a `clinic_id` now, costly later.)
