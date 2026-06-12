"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { honeyAdjustments } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createHoneyAdjustment(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  const date = formData.get("date") as string;
  const type = formData.get("type") as "jarring_loss" | "other";
  const amountLbs = formData.get("amountLbs") as string;
  const reason = formData.get("reason") as string;

  if (!date) return { error: "Date is required" };
  if (!type) return { error: "Type is required" };
  if (!amountLbs) return { error: "Amount is required" };

  await db.insert(honeyAdjustments).values({
    date: new Date(date),
    type,
    amountLbs: parseFloat(amountLbs),
    reason: reason?.trim() || null,
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function getHoneyAdjustments() {
  await requireSession();
  return db
    .select()
    .from(honeyAdjustments)
    .orderBy(desc(honeyAdjustments.date));
}
