import { Pool } from "pg";

declare global {
  // Reuse one pool across warm Next.js serverless invocations.
  // eslint-disable-next-line no-var
  var __websiteTestingLabsPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __websiteTestingLabsSchemaReady: Promise<void> | undefined;
}

export function sharedHistoryEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getReportPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  if (!globalThis.__websiteTestingLabsPool) {
    globalThis.__websiteTestingLabsPool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      allowExitOnIdle: true,
    });
  }
  return globalThis.__websiteTestingLabsPool;
}

export async function ensureReportSchema(pool: Pool): Promise<void> {
  if (!globalThis.__websiteTestingLabsSchemaReady) {
    globalThis.__websiteTestingLabsSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS website_testing_lab_reports (
        run_id TEXT PRIMARY KEY,
        lab TEXT NOT NULL,
        url TEXT NOT NULL,
        reference_url TEXT,
        completed_at TIMESTAMPTZ NOT NULL,
        pages_scanned INTEGER NOT NULL DEFAULT 0,
        report_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS website_testing_lab_reports_completed_idx
      ON website_testing_lab_reports (completed_at DESC);
    `).then(() => undefined).catch((error) => {
      globalThis.__websiteTestingLabsSchemaReady = undefined;
      throw error;
    });
  }
  await globalThis.__websiteTestingLabsSchemaReady;
}
