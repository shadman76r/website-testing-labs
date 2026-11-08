import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isAuthenticatedToken } from "@/lib/auth";
import { ensureReportSchema, getReportPool } from "@/lib/report-db";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const cookieStore = await cookies();
  if (!isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const pool = getReportPool();
  if (!pool) return NextResponse.json({ error: "Shared report history is not configured." }, { status: 404 });
  const { runId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(runId)) {
    return NextResponse.json({ error: "Invalid report ID." }, { status: 400 });
  }
  try {
    await ensureReportSchema(pool);
    const result = await pool.query(
      "SELECT report_json FROM website_testing_lab_reports WHERE run_id = $1 LIMIT 1",
      [runId]
    );
    if (!result.rowCount) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    return NextResponse.json({ data: result.rows[0].report_json }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the report.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
