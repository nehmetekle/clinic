# NutriClinic — Clinic Management (Version 2: Backend + Database)

A clinic operating system for a nutrition / dietitian practice. This is
**Version 2** of a 4-version plan:

1. Version 1 — Front-end clickable demo ✅
2. **Version 2 — Backend + database** ← you are here ✅
3. Version 3 — Real authentication + permissions
4. Version 4 — Reports, receipts, reminders, deployment

The UI looks the same as V1, but it now reads and writes through a real
database and REST API — no more in-memory mock data. Full product spec, schema,
and roadmap live in [`docs/`](docs/).

## Architecture (V2)

```
Browser (React pages, useApi hook)
   │  fetch /api/*
Next.js route handlers  ──  zod validation
   │
Services (dashboard aggregates)  ──  Repositories (Prisma queries + mappers)
   │
Prisma  ──  SQLite (dev)  ·  swap datasource → PostgreSQL for production
```

- **Database:** Prisma + SQLite for zero-setup local dev. Production switches the
  `datasource` provider in [prisma/schema.prisma](prisma/schema.prisma) to
  `postgresql` — models are unchanged.
- **API:** REST under `/api` (`clients`, `clients/[id]`, `packages`,
  `appointments`, `consultations`, `payments`, `expenses`, `staff`, `audit`,
  `dashboard`). GET reads + POST creates, with `zod` validation and consistent
  error responses.
- **Server layers:** `src/server/db.ts` (Prisma client) → `repositories/*`
  (data access + DB→DTO mappers) → `services/*` (aggregations).
- **Frontend data layer:** `src/lib/api.ts` (typed client) + `src/lib/use-api.ts`
  (loading/error/refetch hook). Create forms POST then refetch.
- **Business rules in the backend:** receipt numbers, auto-BMI, visit numbering,
  and one-session-decrement-per-completed-consultation (transactional).

## What works in this demo

- **Role-based login** — pick Secretary, Dietitian, or Admin (or switch live via the
  top-bar "Demo role" selector). Each role gets its own sidebar, dashboard, and pages.
- **Secretary dashboard** — quick actions, today's appointments, check-in queue, recent payments.
- **Dietitian dashboard** — today's clients, waiting list, recent consultations, follow-up reminders.
- **Admin dashboard** — income / expenses / profit KPIs, charts, staff activity.
- **Clients** — searchable, filterable list → full client profile with tabs (Overview, Personal,
  Package, Appointments, Consultations, Measurements, Payments, Notes).
- **Add New Client** — 4-step wizard (Info → Package → Payment → Appointment).
- **Today's Queue** — interactive board; advance a client Scheduled → Checked-in → Waiting →
  With dietitian → Completed.
- **Consultation editor** — measurements with **auto-BMI** and a side-by-side "previous visit"
  compare pane.
- **Progress** — weight trend chart + consultation timeline.
- **Packages, Payments, Expenses** — tables + create modals.
- **Reports** — admin analytics with filters + unpaid balances.
- **Staff, Settings, Audit log** — admin management screens.
- **Global search** (top bar) — live results for clients (name/phone/email) and payments (receipt #), click to jump.
- **Notifications** ("needs attention") dropdown — unpaid balances, expiring packages, no-shows.
- **Toast feedback** on every save (payments, expenses, packages, staff, appointments, queue check-ins, settings).
- **Role-scoped privacy** — clinical notes, allergies, measurements and files are hidden from the secretary.

> All data is mock/in-memory (`src/lib/mock-data.ts`). Nothing is persisted — that arrives in Version 2.

## Run it

```bash
npm install                 # install dependencies
npx prisma migrate dev      # create the local Postgres DB from migrations
npm run db:create-admin     # create the one admin account from ADMIN_EMAIL/ADMIN_PASSWORD in .env
npm run dev                 # http://localhost:3000
```

Helpful scripts: `npm run db:studio` (browse the DB in Prisma Studio), `npm run
db:reset` (wipe the database back to empty).

Open http://localhost:3000 → log in with the `ADMIN_EMAIL`/`ADMIN_PASSWORD` you set
in `.env`. There is no demo data and no role picker — every account is real.

> Real login (email + password, Argon2id), server-enforced sessions/RBAC, and
> optional 2FA (admin) all shipped in Version 3 — see `CLAUDE.md`.

## Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS · Recharts · lucide-react ·
**Prisma · PostgreSQL · Zod**.

## Project structure

```
prisma/
  schema.prisma             # data model (PostgreSQL)
  create-admin.ts           # creates the one admin account from .env
  migrations/
src/
  app/
    login/                  # login page
    api/                    # REST route handlers (clients, payments, dashboard, …)
    (app)/                  # authenticated shell (sidebar + topbar)
      dashboard/  clients/  queue/  appointments/  consultations/  progress/
      packages/  payments/  expenses/  reports/  staff/  settings/  audit/
  components/
    ui/                     # Card, Button, Table, Badge, Tabs, Modal, fields, States
    layout/                 # Sidebar, Topbar, AppShell, GlobalSearch, Notifications
    charts/                 # Recharts wrappers
  server/
    db.ts                   # Prisma client singleton
    serialize.ts            # DB row → API DTO mappers
    repositories/           # data access per entity
    services/               # dashboard aggregations
    http.ts                 # JSON + validation helpers
  lib/
    api.ts use-api.ts types.ts validation.ts config.ts
    session.tsx toast.tsx nav.ts utils.ts
docs/                       # product spec, DB schema, roadmap (Versions 1–4)
```
