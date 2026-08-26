import { db } from "../db";
import { toBotoxItem } from "../serialize";
import { NotFoundError } from "../http";
import type { BotoxItem } from "@/lib/types";
import type { CreateBotoxItemInput, UpdateBotoxItemInput } from "@/lib/validation";

/** Active items first, then alphabetical — used by the visit Botox picker. */
export async function listBotoxItems(): Promise<BotoxItem[]> {
  const rows = await db.botoxItem.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return rows.map(toBotoxItem);
}

export async function createBotoxItem(input: CreateBotoxItemInput): Promise<BotoxItem> {
  const row = await db.botoxItem.create({
    data: {
      name: input.name,
      price: input.price,
      cost: input.cost ?? 0,
      currency: "USD",
      active: input.active ?? true,
    },
  });
  return toBotoxItem(row);
}

export async function updateBotoxItem(id: string, input: UpdateBotoxItemInput): Promise<BotoxItem> {
  const existing = await db.botoxItem.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Botox item not found");
  const row = await db.botoxItem.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      price: input.price ?? undefined,
      cost: input.cost ?? undefined,
      active: input.active ?? undefined,
    },
  });
  return toBotoxItem(row);
}

/** Hard delete, mirroring Product: a line already charged on a visit keeps its
 * own frozen name/basePrice snapshot (ConsultationBotoxItem), so removing the
 * catalog row it came from can't corrupt history. */
export async function deleteBotoxItem(id: string): Promise<void> {
  const existing = await db.botoxItem.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Botox item not found");
  await db.botoxItem.delete({ where: { id } });
}
