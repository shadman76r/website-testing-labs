export type LabId =
  | "responsive"
  | "functional"
  | "visual"
  | "seo-geo"
  | "performance"
  | "accessibility"
  | "redirect-links";

export type CheckStatus = "PASS" | "FAIL" | "WARNING" | "NOT_CHECKED";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface LabCheck {
  id: string;
  name: string;
  status: CheckStatus;
  severity: Severity;
  expected: string;
  actual: string;
  recommendation?: string;
  pageUrl?: string;
}

export interface ScreenshotEvidence {
  label: string;
  dataUrl: string;
}

export interface LabScore {
  label: string;
  value: number;
  detail?: string;
}

export interface LabMetric {
  label: string;
  value: number | null;
  unit: string;
  status: CheckStatus;
  target?: string;
}

export interface LabResult {
  runId?: string;
  lab: LabId;
  url: string;
  referenceUrl?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  finalUrl?: string;
  pageTitle?: string;
  pagesScanned: number;
  discoveredPages: string[];
  crawlComplete?: boolean;
  crawlWarnings?: string[];
  logs?: string[];
  scores?: LabScore[];
  metrics?: LabMetric[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    notChecked: number;
  };
  checks: LabCheck[];
  screenshots: ScreenshotEvidence[];
  notes: string[];
}
