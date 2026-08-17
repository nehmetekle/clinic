-- Freeze cost of goods sold at the transaction (audit finding F-03).
--
-- Before this migration the clinic's own cost existed ONLY on the live catalog
-- rows (`Product.cost`, `ServicePrice.cost`, `Package.cost`). Nothing copied a
-- cost onto the transaction that consumed it, so:
--
--   * gross profit could not be computed for products or treatments at all, and
--   * any figure that tried would have been valued at TODAY's catalog cost,
--     silently rewriting the margin of visits that closed months ago.
--
-- These four columns are the counterpart of the `price`/`unitPrice` snapshots
-- that already sit next to them: the cost is captured once, at the moment of
-- sale or delivery, and is never re-derived from the catalog afterwards.
--
-- DEFAULT 0 IS NOT "FREE". Existing rows predate cost capture and their true
-- historical cost was never recorded anywhere — it is not reconstructible, and
-- backfilling it from today's catalog is exactly the rewrite this migration
-- exists to prevent. Reporting must therefore treat pre-cutover rows as
-- UNKNOWN cost rather than zero cost; see the cutover note in
-- docs/known-issues.md. The zero default exists only because Postgres needs one
-- for a NOT NULL column on a populated table.

-- Per-session cost of a pay-as-you-go treatment plan, from ServicePrice.cost.
ALTER TABLE "SessionPlan"
  ADD COLUMN "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Per-session/per-treatment cost of a treatment delivered inside a visit.
ALTER TABLE "ConsultationTreatment"
  ADD COLUMN "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Per-unit cost of a product sold on a visit. COGS = "unitCost" * "quantity".
ALTER TABLE "ConsultationProduct"
  ADD COLUMN "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Per-session cost of a session consumed by a machine-only visit. Machine
-- visits never bill, so this is the only cost signal they leave behind.
ALTER TABLE "MachineVisitItem"
  ADD COLUMN "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- A cost can never be negative. These CHECKs are hand-written SQL that Prisma
-- cannot express in schema.prisma — do not lose them in a migration squash
-- (same standing rule as the Jessy, multi-currency and session-plan CHECKs).
ALTER TABLE "SessionPlan"
  ADD CONSTRAINT "SessionPlan_unitCost_nonnegative" CHECK ("unitCost" >= 0);
ALTER TABLE "ConsultationTreatment"
  ADD CONSTRAINT "ConsultationTreatment_unitCost_nonnegative" CHECK ("unitCost" >= 0);
ALTER TABLE "ConsultationProduct"
  ADD CONSTRAINT "ConsultationProduct_unitCost_nonnegative" CHECK ("unitCost" >= 0);
ALTER TABLE "MachineVisitItem"
  ADD CONSTRAINT "MachineVisitItem_unitCost_nonnegative" CHECK ("unitCost" >= 0);

-- Blood-test costs are captured inside the existing `Consultation.bloodTestCharges`
-- JSON snapshot (a new `cost` key alongside `price`), so they need no column
-- here. Rows written before this migration have no `cost` key at all, which is
-- deliberately distinguishable from a recorded cost of 0.
