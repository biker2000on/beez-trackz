import { NextRequest, NextResponse } from "next/server";
import {
  createInspectionRecord,
  updateInspectionRecord,
  deleteInspectionRecord,
  type InspectionRecordInput,
} from "@/lib/db/inspections";

const UPDATABLE_FIELDS = [
  "queenSeen",
  "queenHealth",
  "broodPattern",
  "storesHoney",
  "storesPollen",
  "temperament",
  "pests",
  "treatments",
  "notes",
] as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, data } = body;

    if (!action || !data) {
      return NextResponse.json({ error: "Missing action or data" }, { status: 400 });
    }

    switch (action) {
      case "create": {
        const record = data as Omit<InspectionRecordInput, "date"> & { date: string };
        if (!record.hiveId || !record.date) {
          return NextResponse.json({ error: "hiveId and date are required" }, { status: 400 });
        }
        await createInspectionRecord({ ...record, date: new Date(record.date) });
        return NextResponse.json({ success: true });
      }

      case "update": {
        const record = data as { id: string; [key: string]: unknown };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for update" }, { status: 400 });
        }
        const fields: Record<string, unknown> = {};
        for (const key of UPDATABLE_FIELDS) {
          if (record[key] !== undefined) fields[key] = record[key];
        }
        await updateInspectionRecord(record.id, fields);
        return NextResponse.json({ success: true });
      }

      case "delete": {
        const record = data as { id: string };
        if (!record.id) {
          return NextResponse.json({ error: "id is required for delete" }, { status: 400 });
        }
        await deleteInspectionRecord(record.id);
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
