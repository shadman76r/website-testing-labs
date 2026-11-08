import { NextResponse } from "next/server";
import { isPasswordConfigured } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    application: "Website Testing Labs",
    browserEngine: "Playwright",
    vercelRuntime: Boolean(process.env.VERCEL),
    accessPasswordConfigured: isPasswordConfigured(),
    timestamp: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
