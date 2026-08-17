-- Basket line integrity: frozen prices, separately-accounted discounts, and a
-- traceable bundle line.
--
-- THE RULE THIS ENFORCES: a discount is not a price edit.
--
-- `unitPrice` is what the item costs according to its source — the catalog, the
-- session plan, the bundle — and nobody may retype it at the counter. Any
-- reduction the client is given lives in `discountAmount`, alongside it, so the
-- original price stays auditable forever and the reduction is visible as a
-- reduction rather than disguised as a cheaper item.
--
--   sale amount for a line = unitPrice * quantity - discountAmount
--
-- The allocation of a whole-bill discount across the lines is computed with a
-- largest-remainder rule at settlement, so the line amounts sum EXACTLY to what
-- was charged. Without that, a $100 bill split three ways at 10% loses or gains a
-- cent between "the sum of the lines" and "the total", and revenue stops
-- reconciling to the bill.

ALTER TABLE "VisitBasketItem"
  ADD COLUMN "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "VisitBasketItem"
  ADD COLUMN "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Links a bundle line to the ClientPackage it sells. Previously a bundle entered
-- the basket as an anonymous "custom" line: nothing tied the money on the bill to
-- the package row, so the package's actual agreed price was unrecoverable as soon
-- as a bill-level discount was applied, and the line could not be
-- price-protected because it was indistinguishable from a secretary's ad-hoc
-- charge. RESTRICT, not SetNull: a sold line must never be orphaned from the
-- package it sold.
ALTER TABLE "VisitBasketItem" ADD COLUMN "clientPackageId" TEXT;
CREATE INDEX "VisitBasketItem_clientPackageId_idx" ON "VisitBasketItem"("clientPackageId");
ALTER TABLE "VisitBasketItem"
  ADD CONSTRAINT "VisitBasketItem_clientPackageId_fkey"
  FOREIGN KEY ("clientPackageId") REFERENCES "ClientPackage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECKs Prisma cannot express — do not lose them in a squash.
--
-- A discount can never be negative (that would be a surcharge smuggled in as a
-- discount) and can never exceed the line's own gross value (that would be a
-- refund, which this application does not have anywhere, by design).
ALTER TABLE "VisitBasketItem"
  ADD CONSTRAINT "VisitBasketItem_discount_within_line" CHECK (
    "discountAmount" >= 0 AND "discountAmount" <= "unitPrice" * "quantity"
  );

ALTER TABLE "VisitBasketItem"
  ADD CONSTRAINT "VisitBasketItem_unitCost_nonnegative" CHECK ("unitCost" >= 0);
