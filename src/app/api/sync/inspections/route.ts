import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { inspections } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, data } = body;

    if (!action || !data) {
      return NextResponse.json({ error: "Missing action or data" }, { status: 400 });
    }

    switch (action) {
      case "create": {
        const record = data as {
          hiveId: string;
          date: string;
          queenSeen?: boolean;
          queenHealth?: string;
          broodPattern?: string;
          storesHoney?: number;
          storesPollen?: number;
          temperament?: number;
          pests?: unknown;
          treatments?: unknown;
          notes?: string;
        };

        if (!record.hiveId || !record.date) {
          return NextResponse.json({ error: "hiveId and date are required" }, { status: 400 });
        }

        await db.insert(inspections).values({
          hiveId: record.hiveId,
          date: new Date(record.date),
          queenSeen: record.queenSeen ?? null,
          queenHealth: record.queenHealth ?? null,
          broodPattern: record.broodPattern ?? null,
          storesHoney: record.storesHoney ?? null,
          storesPollen: record.storesPollen ?? null,
          temperament: record.temperament ?? null,
          pests: record.pests ?? null,
          treatments: record.treatments ?? null,
          notes: record.notes ?? null,
        });

        return NextResponse.json({ success: true });
      }

      case "update": {
        const record = data as { id: string; [key: string]: unknown };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for update" }, { status: 400 });
        }

        const { id, ...fields } = record;
        const updateData: Record<string, unknown> = {};

        if (fields.queenSeen !== undefined) updateData.queenSeen = fields.queenSeen;
        if (fields.queenHealth !== undefined) updateData.queenHealth = fields.queenHealth;
        if (fields.broodPattern !== undefined) updateData.broodPattern = fields.broodPattern;
        if (fields.storesHoney !== undefined) updateData.storesHoney = fields.storesHoney;
        if (fields.storesPollen !== undefined) updateData.storesPollen = fields.storesPollen;
        if (fields.temperament !== undefined) updateData.temperament = fields.temperament;
        if (fields.pests !== undefined) updateData.pests = fields.pests;
        if (fields.treatments !== undefined) updateData.treatments = fields.treatments;
        if (fields.notes !== undefined) updateData.notes = fields.notes;
        updateData.updatedAt = new Date();

        await db.update(inspections).set(updateData).where(eq(inspections.id, id));
        return NextResponse.json({ success: true });
      }

      case "delete": {
        const record = data as { id: string };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for delete" }, { status: 400 });
        }

        await db.delete(inspections).where(eq(inspections.id, record.id));
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Sync inspections error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
