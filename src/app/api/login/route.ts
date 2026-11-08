import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, verifyAppPassword } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";

  if (process.env.NODE_ENV === "production" && !process.env.APP_ACCESS_PASSWORD) {
    return NextResponse.json({ error: "APP_ACCESS_PASSWORD is not configured in the deployment environment." }, { status: 503 });
  }
  if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    return NextResponse.json({ error: "SESSION_SECRET must contain at least 32 characters." }, { status: 503 });
  }
  if (!verifyAppPassword(password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  try {
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Unable to create a secure session. Check SESSION_SECRET." }, { status: 503 });
  }
}
