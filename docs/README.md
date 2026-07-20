# NutriClinic — Documentation Index

A clinic operating system for a nutrition / dietitian practice: front desk →
consultation → business reporting, in one app, with role-based access.

| Doc | Contents |
|---|---|
| [01-product-spec.md](01-product-spec.md) | Product summary, roles & permission matrix, all feature areas, auto-calculations, non-functional requirements. |
| [02-database-schema.md](02-database-schema.md) | PostgreSQL schema (full DDL), ER overview, integrity rules, reporting views. |
| [03-pages-flows-ui.md](03-pages-flows-ui.md) | Navigation, 17 pages, dashboard wireframes, client profile, consultation editor, the 5 core flows. |
| [04-implementation-plan.md](04-implementation-plan.md) | Recommended stack, architecture, 9 build phases, security checklist, test strategy, repo layout, open decisions. |
| [05-additional-features.md](05-additional-features.md) | Suggested features that make it a real clinic OS, by priority. |

**Roles:** Secretary/Receptionist · Dietitian · Admin/Owner.
**Stack (recommended):** Next.js + TypeScript + Tailwind/shadcn + Prisma + PostgreSQL + Auth.js.
**Start here for building:** `04-implementation-plan.md` → Phase 0.
