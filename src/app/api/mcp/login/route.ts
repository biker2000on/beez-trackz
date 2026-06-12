import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { verifyPassword } from "@/lib/auth";
import { createSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }

    const users = await db.select().from(userSettings).limit(1);
    if (users.length === 0) {
      return NextResponse.json({ error: "Setup not complete" }, { status: 400 });
    }

    const user = users[0];
    if (!user.passwordHash) {
      return NextResponse.json(
        { error: "Password login is not configured for this instance" },
        { status: 401 }
      );
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const token = await createSession({ sub: "password" });
    const response = NextResponse.json({ success: true, token });
    
    // Set session cookie for web clients
    response.cookies.set("session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });

    return response;
  } catch (err) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
