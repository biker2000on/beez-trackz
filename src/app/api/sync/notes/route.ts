import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, data } = body;

    if (!action || !data) {
      return NextResponse.json({ error: "Missing action or data" }, { status: 400 });
    }

    // Notes sync is a placeholder - notes are stored as part of inspections
    // This endpoint accepts the sync call gracefully
    console.log(`Notes sync: action=${action}`, data);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Sync notes error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
