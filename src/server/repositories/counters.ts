import { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * Atomically bumps a named counter and returns its new value. The database
 * applies the increment as a single locked `UPDATE ... value = value + 1`, so
 * concurrent callers are serialized and always receive distinct, strictly
 * increasing values — impossible to hand out the same number twice. Because the
 * counter only ever moves forward, deleting the row a number was issued for
 * never frees that number for reuse.
 *
 * Pass the surrounding transaction client so the bump commits (or rolls back)
 * together with the row it numbers; defaults to the shared client otherwise.
 */
export async function nextCounterValue(
  key: string,
  client: Prisma.TransactionClient = db,
): Promise<number> {
  const row = await client.counter.upsert({
    where: { key },
    // Safety net for a never-seeded counter; migrations seed it up front so the
    // update branch is what runs in practice.
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
    select: { value: true },
  });
  return row.value;
}
