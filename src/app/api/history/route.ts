import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, isAuthenticatedToken } from "@/lib/auth";
import { ensureReportSchema, getReportPool, sharedHistoryEnabled } from "@/lib/report-db";

export const runtime = "nodejs";
export const maxDuration = 30;

const saveSchema = z.object({ report: z.any() });

export async function GET() {
  const cookieStore = await cookies();
  if (!isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const pool = getReportPool();
  if (!pool) return NextResponse.json({ enabled: false, items: [] });

  try {
    await ensureReportSchema(pool);
    const result = await pool.query(`
      SELECT
        run_id AS "runId",
        lab,
        url,
        reference_url AS "referenceUrl",
        completed_at AS "completedAt",
        pages_scanned AS "pagesScanned",
        report_json->'summary' AS summary,
        report_json->'scores' AS scores
      FROM website_testing_lab_reports
      ORDER BY completed_at DESC
      LIMIT 100
    `);
    return NextResponse.json({ enabled: true, items: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load shared report history.";
    return NextResponse.json({ enabled: false, error: message, items: [] }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const pool = getReportPool();
  if (!pool) return NextResponse.json({ enabled: false, message: "DATABASE_URL is not configured; browser-local history remains active." });

  const body = await request.json().catch(() => null);
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid report payload." }, { status: 400 });

  const incoming = parsed.data.report as any;
  if (
    typeof incoming?.runId !== "string" ||
    typeof incoming?.lab !== "string" ||
    typeof incoming?.url !== "string" ||
    typeof incoming?.completedAt !== "string" ||
    !incoming?.summary ||
    !Array.isArray(incoming?.checks)
  ) {
    return NextResponse.json({ error: "Report is missing required fields." }, { status: 400 });
  }

  // Store all checks and score data, but omit base64 screenshots to keep shared history efficient.
  const report = {
    ...incoming,
    screenshots: [],
    logs: Array.isArray(incoming.logs) ? incoming.logs.slice(-100) : [],
  };
  const json = JSON.stringify(report);
  if (Buffer.byteLength(json, "utf8") > 3_500_000) {
    return NextResponse.json({ error: "This report is too large for one shared-history record. The full report remains available in this browser; export its PDF/JSON." }, { status: 413 });
  }

  try {
    await ensureReportSchema(pool);
    await pool.query(`
      INSERT INTO website_testing_lab_reports
        (run_id, lab, url, reference_url, completed_at, pages_scanned, report_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET
        lab = EXCLUDED.lab,
        url = EXCLUDED.url,
        reference_url = EXCLUDED.reference_url,
        completed_at = EXCLUDED.completed_at,
        pages_scanned = EXCLUDED.pages_scanned,
        report_json = EXCLUDED.report_json
    `, [
      report.runId,
      report.lab,
      report.url,
      report.referenceUrl || null,
      report.completedAt,
      report.pagesScanned || 0,
      json,
    ]);
    await pool.query(`
      DELETE FROM website_testing_lab_reports
      WHERE run_id IN (
        SELECT run_id FROM website_testing_lab_reports
        ORDER BY completed_at DESC
        OFFSET 100
      )
    `);
    return NextResponse.json({ enabled: true, saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save shared report history.";
    return NextResponse.json({ enabled: false, error: message }, { status: 503 });
  }
}
