# Migrations — deploying safely, and the Online Booking drift

Two things live here: the **runbook** for getting a migration onto a live database
without losing data, and the **specific mess** created by the unmerged
`online-booking` branch, including how to merge it later without repeating it.

**Verdict, if you read nothing else** (settled 2026-09-03):

- `BookingRequest` existed in **both dev and production**, with both of its
  migrations recorded as applied in each. **The production table is EMPTY (0
  rows)** — no data to preserve or migrate.
- **Dev is fixed**: reset and replayed from the repo. 31 migration rows, no
  booking artifacts, `migrate diff` reports *"No difference detected."*
- **Production: leave it exactly as it is.** The empty table and its two history
  rows are harmless. Deploying
  `20260902120000_external_lab_blood_collection` is **GO — safe, zero risk to
  existing data**, rehearsed against a faithful copy of production's state (§4).
- The one real hazard is in the future: merging `online-booking` naively **will**
  break the next production deploy (§5, with the failure reproduced).

---

## 1. How the drift happened (and why it will happen again if nothing changes)

`online-booking` is a **local-only branch**: never merged into `main`, never
pushed to `origin`. Verified:

```bash
git merge-base --is-ancestor fae99a7 main   # -> false, never merged
git ls-remote --heads origin | grep booking # -> nothing, never pushed
git branch -a --contains fae99a7            # -> online-booking, only
```

It adds two migrations that exist **only** on that branch:

- `20260825105347_add_booking_requests`
- `20260825121340_split_booking_request_name`

### The actual mechanism — confirmed via Vercel's deployment history (2026-09-03)

`vercel.json`'s `buildCommand` is:

```
prisma generate && prisma migrate deploy && next build
```

**This runs on every deployment, Preview included — not just Production.** The
Vercel deployment list shows `feature online booking` (`fae99a7`) built as a
**Preview** on 2026-08-25, the same day its two `BookingRequest` migrations
appeared in the production database. `online-booking` was never merged to
`main` (§1 above) and was never pushed under that branch name either — the
deployment list shows it associated with `security` at build time, consistent
with the branch having been renamed/repointed around then (see the reflog in
§1). None of that matters for the mechanism: **a never-merged branch's
migrations reached production because a Preview build for it ran `migrate
deploy` against the production database.**

That means the real trigger was never "merge to `main`" — it was **pushing a
branch that touches `prisma/migrations/` to origin at all**, if (as the
evidence here strongly implies) the Preview environment's `DATABASE_URL` /
`DIRECT_URL` are the same values as Production's. `.env.example` and
CLAUDE.md's "Run it" section both describe only one connection string per
environment, with no mention of a separate Preview database — consistent with
them never having been split.

**Action needed, outside git entirely:** in Vercel → Project Settings →
Environment Variables, confirm whether `DATABASE_URL`/`DIRECT_URL` differ
between the Preview and Production environment scopes. If they don't, either
point Preview at its own database (a Neon branch database is free and
instant — and mirrors how Neon branching is meant to be used) or remove
`prisma migrate deploy` from the Preview build path. Until this is fixed,
**every future branch that adds a migration will silently apply it to
production the moment it is pushed**, regardless of whether or when it is
merged — no approval step, no "going live" decision, involved at all.

### What actually happened, to the second

The reflog dates the episode to 2026-08-25: the branch was created (renamed from
`temp`), worked on, and checked out away from later the same day.

| when (UTC) | what | where |
| --- | --- | --- |
| 10:53:47 | `add_booking_requests` applied | **dev** |
| 12:13:52 | `split_booking_request_name` applied | **dev** |
| **16:38:02** | **commit `fae99a7` "feature online booking"** | — |
| 16:38:20.05 | `add_booking_requests` applied | **production** |
| 16:38:20.71 | `split_booking_request_name` applied | **production** |
| 16:49:12 | `appointment_slot_key_drops_dietitian` applied | dev |
| 17:04:02 | `appointment_slot_key_drops_dietitian` applied | production |

The two production rows land **18 seconds after the commit** and **0.67 seconds
apart** — a single `migrate deploy` run, fired at the production database
immediately after committing the feature, from a working copy that had the
online-booking migrations in it. `.env` was pointing at Neon at that moment.

This is the whole failure in one line: **the migrations that get applied are the
ones on your disk, and the database they hit is whatever `.env` says** — neither
has anything to do with what is merged.

**The mechanism, stated plainly:** `prisma migrate dev` applies whatever is in
`prisma/migrations/` **on the currently checked-out branch** to whatever database
`.env` is pointing at. Switching back to `main` removes the migration *files* but
does nothing to the *database*, which keeps both the tables and the history rows.
Prisma then reports drift forever after, because the database contains applied
migrations the repo has never heard of.

### The ordering hazard this also created

Note the timestamps above: `...121340_split_booking_request_name` was applied
**before** `...120000_appointment_slot_key_drops_dietitian`, but sorts **after**
it by name. Prisma applies migrations in **filename order**, not application
order. So a database built by replaying the repo from scratch and the drifted dev
database do not merely differ in content — they applied overlapping changes in a
**different order**. That is harmless here (the two touch unrelated tables) but is
exactly how a rebased feature branch silently produces a schema that works on one
machine and fails on another.

---

## 2. Where `BookingRequest` actually exists

**Both. Verified directly on 2026-09-02 via `scripts/probe-db.sh`.**

| database | `BookingRequest` table | booking rows in `_prisma_migrations` | External Lab applied |
| --- | --- | --- | --- |
| **dev** (`localhost:5433/nutriclinic`) | ~~YES (5 rows)~~ **removed by the §3 reset** | ~~YES~~ **removed** | yes — genuine replay |
| **production** (`neondb`, Neon) | **YES — but EMPTY (0 rows)** | **YES** — both, `finished_at` set, not rolled back | **pending — cleared to deploy** |

The production table being **empty** is what makes §4's "leave it alone" the
obvious call rather than a trade-off: there is nothing in it to preserve, nothing
to migrate, and nothing that can be lost. It is an unused, unreferenced, empty
table that the Online Booking feature will populate if and when it ships.

Production carries **32** migration rows: the 30 that `main` has ever had, plus
the two booking ones. The repo has **31** (those 30 plus External Lab). So
production is missing exactly one migration —
`20260902120000_external_lab_blood_collection` — and carries two the repo has
never heard of.

Production shows the **same name-vs-application ordering inversion** as dev:
`...121340_split_booking_request_name` was applied at 16:38:20, before
`...120000_appointment_slot_key_drops_dietitian` at 17:04:02, though it sorts
after it by name.

### The probe

```sh
# Prints booking-like tables, booking-like migration rows, and the full
# migration history. Reads nothing else and writes nothing.
psql "$DIRECT_URL_WITHOUT_PRISMA_PARAMS" -At <<'SQL'
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name ILIKE '%booking%';

SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations WHERE migration_name ILIKE '%booking%';

SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;
SQL
```

`psql` rejects Prisma's `?schema=public` parameter — strip the query string
before passing a Prisma URL to `psql`.

---

## 3. Fixing dev (safe, disposable)

The dev database is disposable — there is no seed data in this project by design,
and the only account that matters is recreated by `db:create-admin`.

```bash
npx prisma migrate reset --force --skip-seed   # drops + replays repo migrations
npm run db:create-admin                        # recreate the one admin from .env
```

**Done on 2026-09-03.** Afterwards: 31 migration rows, 40 tables, zero booking
artifacts, `npx prisma migrate diff --from-schema-datasource ... --exit-code`
returns **0 ("No difference detected")**, and External Lab is recorded as a
genuine replay rather than a manual `resolve`. The admin account was recreated
with `npm run db:create-admin`.

This is the **correct** fix rather than another `migrate resolve`, because it
rebuilds `_prisma_migrations` from the repo, which simultaneously:

- drops the two booking migration rows and the `BookingRequest` table locally,
- removes the manual `migrate resolve --applied` marking that was used as a
  stopgap for the External Lab migration,
- replays every migration **in filename order**, so dev's schema is built the same
  way a fresh production or CI database would be.

**Before resetting**, dump anything you might want:

```bash
pg_dump "$DEV_URL" -f dev-before-reset.sql              # everything
pg_dump "$DEV_URL" -t '"BookingRequest"' -f booking.sql # just the booking rows
```

After the reset, `npx prisma migrate dev` must report **no drift and nothing to
apply**. If it doesn't, stop — the repo and the database still disagree.

### The replay is verified

The repo's full migration set was replayed onto an empty database on 2026-09-02
to prove the reset (and the production deploy in §6) lands cleanly:

```
createdb nutriclinic_replaycheck
DATABASE_URL=... DIRECT_URL=... npx prisma migrate deploy   # 31 migrations, all applied
DATABASE_URL=... DIRECT_URL=... npx prisma migrate status   # "Database schema is up to date!"
```

Confirmed on the replayed database: **0** booking-related tables, all three
external-lab CHECK constraints present
(`external_lab_below_cost_needs_reason`, `external_lab_order_currency_usd`,
`external_lab_order_totals_nonnegative`), and `VisitBasketItem.externalLabOrderId`
created **nullable**. The scratch database was dropped afterwards.

This is worth repeating before any future deploy — it is the cheapest possible
check that the repo alone can rebuild the schema, and it is exactly what a fresh
production database does.

---

## 4. Production has it. Here is why that is safe, and what to do.

**Deploying External Lab to production is safe. Verified by rehearsal, not by
reasoning.** Production's exact state was reproduced on a local database (all 30
`main` migrations + the two booking migrations applied + their history rows + a
`BookingRequest` row), then `npx prisma migrate deploy` was run against it:

```
### migrate status BEFORE
The last common migration is: 20260825120000_appointment_slot_key_drops_dietitian
The migration have not yet been applied:
20260902120000_external_lab_blood_collection
The migrations from the database are not found locally in prisma/migrations:
20260825105347_add_booking_requests
20260825121340_split_booking_request_name

### migrate deploy
  └─ 20260902120000_external_lab_blood_collection/
All migrations have been successfully applied.
```

Post-deploy on the simulated production database:

| check | result |
| --- | --- |
| migrations applied | **exactly 1** (External Lab) |
| `BookingRequest` table | **still present** |
| `BookingRequest` rows | **preserved** |
| booking rows in `_prisma_migrations` | **both intact, not rolled back** |
| External Lab tables | 2, created |
| External Lab CHECK constraints | all 3 present |
| `VisitBasketItem.externalLabOrderId` | created **nullable** |
| `migrate status` afterwards | *"Database schema is up to date!"* |

`migrate deploy` **applies only what the database is missing and ignores history
rows it does not recognise.** The unknown booking migrations are reported as an
informational line, not an error. (`migrate dev` is the one that refuses and
demands a reset — never run it against production.)

### What to do with the table

Do **not** drop the table, and do **not** "tidy" its history. Keep it exactly
where it is (the feature may ship later) and leave the history alone:

1. **Confirm what is in it.** `SELECT count(*) FROM "BookingRequest";` and inspect
   a few rows. Real customer booking requests are data; five test rows are not.
   Report before deciding.
2. **Leave the table in place.** It is additive: no other model references it, so
   it cannot break any query in `main`. An unused table costs nothing.
3. **Leave its history rows in place too.** Extra rows in `_prisma_migrations`
   that the repo lacks produce a drift *warning* from `migrate dev`, but
   `migrate deploy` — which is what production uses — **only applies migrations
   the database is missing and never inspects the ones it doesn't recognise**. It
   will not fail, and it will not touch `BookingRequest`.
4. **Do not `migrate resolve --rolled-back`** on the booking migrations. That
   marks them as failed/reverted while the table still exists, which makes the
   later real merge (§5) try to create a table that is already there.
5. **Never run `migrate reset` against production.** It drops everything.

The only genuine hazard is a future migration that assumes `BookingRequest` does
not exist (e.g. the merge in §5 creating it). §5 handles that.

---

## 5. Merging `online-booking` later, without repeating this

The branch's two migrations were authored against a database that has since moved
on. Merging the files as-is will misorder them relative to `main`'s later
migrations.

**At merge time:**

1. **Rebase the branch onto current `main` first**, so its code sits on top of
   everything that has shipped since.
2. **Renumber the migration directories** so their timestamps sort *after* every
   migration already on `main`. Prisma orders by directory name, so the two
   booking directories must be renamed to timestamps later than the newest
   `main` migration (currently `20260902120000_external_lab_blood_collection`).
   Rename the directory only — the `migration.sql` inside is unchanged.
3. **Squash the pair if it is still two files.** `add_booking_requests` followed
   by `split_booking_request_name` is a create followed by an immediate
   correction; a database that has never seen either only needs the end state.
   Keep them separate *only* if a database somewhere has applied just the first.
4. **Make the create idempotent — this is not optional, it is proven.** A naive
   merge (renumbered, but with the original unguarded SQL) was rehearsed against
   the simulated production database. It fails, and it fails badly:

   ```
   Error: P3018  A migration failed to apply. New migrations cannot be applied
   before the error is recovered from.
   Database error code: 42P07
   ERROR: relation "BookingRequest" already exists
   ```

   The damage is not the failed statement — it is that **Prisma records the
   migration as failed, which blocks every subsequent migration** until someone
   manually resolves it. On production that is an outage on the next deploy, not
   just a bad afternoon.

   The recovery path was also rehearsed and works:

   ```bash
   npx prisma migrate resolve --rolled-back 2026xxxx_add_booking_requests
   npx prisma migrate resolve --applied    2026xxxx_add_booking_requests
   npx prisma migrate resolve --applied    2026xxxx_split_booking_request_name
   npx prisma migrate deploy    # -> "No pending migrations to apply."
   ```

   afterwards: `BookingRequest` rows preserved, External Lab tables intact,
   `migrate status` clean. But this is *recovery from a self-inflicted failure* —
   prefer preventing it. Either:
   - guard it (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
     EXISTS`), then reconcile with `migrate resolve --applied` on databases that
     already have it; **or**
   - baseline it: mark the renumbered migration as already applied on those
     databases with `npx prisma migrate resolve --applied <name>` before the first
     `migrate deploy`.

   The guarded version is preferable — it makes the migration correct on *both* a
   fresh database and one that already carries the table, so nobody has to
   remember which is which.
5. **Verify on a clone of production before deploying**, per §6.

**And to stop it recurring:** run feature-branch migrations against a
**branch-specific database**, not the shared dev one. Neon branches are free and
instant; locally, a second Docker database is one command. Point `.env`'s
`DATABASE_URL`/`DIRECT_URL` at it while that branch is checked out.

---

## 6. Runbook — deploying the External Lab migration to a live database

`20260902120000_external_lab_blood_collection` is **additive only**. It:

- creates two new tables (`ConsultationExternalLabOrder`,
  `ConsultationExternalLabTest`),
- adds one **nullable** column (`VisitBasketItem.externalLabOrderId`) with no
  default and no backfill,
- adds three indexes, three foreign keys, and three CHECK constraints **that
  apply only to the new table**.

It contains **no** `DROP`, no `ALTER COLUMN`, no data rewrite, and no constraint
on any existing table. Every existing row remains valid: the new column is NULL
everywhere, which is exactly what every pre-existing basket line should have. The
CHECK constraints are on `ConsultationExternalLabOrder`, which starts empty, so
they cannot reject existing data.

**Risk to existing production data: none.** The only lock taken on an existing
table is a brief `ACCESS EXCLUSIVE` on `VisitBasketItem` to add a nullable column
— in Postgres 11+ that is a catalog-only change with no table rewrite, so it is
effectively instant regardless of table size. The FK addition validates against
an all-NULL column, which is also trivial.

### Before deploying

1. **Take a backup / Neon branch point.** On Neon, create a branch from
   production immediately before deploying — it is instant and gives a rollback
   target. Otherwise `pg_dump`.
2. **Read §4.** Production's `BookingRequest` drift is already confirmed and
   already assessed as safe for this deploy — no action needed beyond leaving it
   alone. Re-run the probe (§2) if more time has passed and other branches may
   have been deployed since.
3. **Rehearse on a copy.** Restore the backup (or use the Neon branch) and run
   `npx prisma migrate deploy` against it. Confirm it reports exactly one
   migration applied and that `npx prisma migrate status` then reports the
   database up to date.
4. **Confirm the deploy user can create tables and constraints** on the target
   schema.

### Deploying

```bash
# DIRECT_URL must point at the UNPOOLED connection — migrations cannot run
# through PgBouncer.
npx prisma migrate deploy
```

`migrate deploy` applies only what is missing and never resets. It does not
prompt, and it ignores migration rows it doesn't recognise (see §4.3).

### After deploying

```bash
npx prisma migrate status   # expect: database schema is up to date
```

Then verify the constraints actually landed — they are hand-written SQL, and a
squash or a partially-applied migration would silently lose them:

```sql
SELECT conname FROM pg_constraint
WHERE conrelid = '"ConsultationExternalLabOrder"'::regclass AND contype = 'c';
-- expect: external_lab_order_totals_nonnegative
--         external_lab_below_cost_needs_reason
--         external_lab_order_currency_usd
```

### Rollback

There is no down-migration (Prisma doesn't generate them). Because the change is
purely additive, the practical rollback is **deploy the previous application
build and leave the schema alone** — the new tables sit unused and the new column
stays NULL. Only drop the tables if you are certain no order has been created;
once one has, dropping them destroys billing records that a settled basket line
still references.

---

## 7. Standing rules

- **Migrations are applied from the branch you have checked out.** Check
  `git branch --show-current` and `.env`'s host before running `migrate dev`.
- **Feature branches get their own database.** See §5.
- **`migrate reset` is for dev only.** The `db:reset` script wipes everything.
- **`migrate resolve --applied` is a stopgap, not a fix.** It tells Prisma to stop
  complaining without changing the schema. It is correct only when the schema
  genuinely already matches the migration.
- **Hand-written SQL is invisible to Prisma.** CHECK constraints and triggers in
  `20260813150000_multi_currency_tender`, `20260812160000_protect_jessy_ledger`,
  `20260813200000_sessions_settle_before_use` and
  `20260902120000_external_lab_blood_collection` cannot be regenerated from
  `schema.prisma`. Never squash migrations without carrying them across.
