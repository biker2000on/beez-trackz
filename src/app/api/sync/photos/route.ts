import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { photos } from "@/db/schema";
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
          ownerType: "hive" | "apiary" | "inspection";
          ownerId: string;
          originalPath: string;
          caption?: string;
          tags?: string[];
        };

        if (!record.ownerType || !record.ownerId || !record.originalPath) {
          return NextResponse.json({ error: "ownerType, ownerId, and originalPath are required" }, { status: 400 });
        }

        await db.insert(photos).values({
          ownerType: record.ownerType,
          ownerId: record.ownerId,
          originalPath: record.originalPath,
          caption: record.caption ?? null,
          tags: record.tags ?? null,
          takenDate: new Date(),
        });

        return NextResponse.json({ success: true });
      }

      case "update": {
        const record = data as { id: string; caption?: string; tags?: string[] };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for update" }, { status: 400 });
        }

        const updateData: Record<string, unknown> = {};
        if (record.caption !== undefined) updateData.caption = record.caption;
        if (record.tags !== undefined) updateData.tags = record.tags;

        await db.update(photos).set(updateData).where(eq(photos.id, record.id));
        return NextResponse.json({ success: true });
      }

      case "delete": {
        const record = data as { id: string };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for delete" }, { status: 400 });
        }

        await db.delete(photos).where(eq(photos.id, record.id));
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Sync photos error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
