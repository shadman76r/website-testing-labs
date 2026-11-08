"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import {
  Activity, Accessibility, ArrowDownUp, ArrowRight, CheckCircle2, ChevronRight,
  CircleAlert, ClipboardList, Code2, Download, ExternalLink, Eye, Gauge,
  Globe2, Image as ImageIcon, Link2, LoaderCircle, LogOut, MonitorSmartphone,
  Search, ShieldCheck, Sparkles, XCircle, Zap, FlaskConical, LayoutDashboard,
  FileText, History, ListChecks, WandSparkles, RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type { LabId, LabResult, CheckStatus, LabMetric } from "@/lib/types";
import { getStoredReports, saveStoredReport, type StoredLabResult } from "@/lib/client/report-store";
import { downloadLabPdf } from "@/lib/client/pdf-report";

type LabItem = {
  id: LabId;
  name: string;
  short: string;
  description: string;
  icon: LucideIcon;
  referenceLabel?: string;
  referencePlaceholder?: string;
};

type HistoryEntry = {
  runId: string;
  lab: LabId;
  url: string;
  referenceUrl?: string;
  completedAt: string;
  pagesScanned: number;
  summary: LabResult["summary"];
  scores?: LabResult["scores"];
  report?: StoredLabResult;
};

type TestCase = {
  id: string;
  module: string;
  title: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  preconditions: string;
  steps: string[];
  expected: string;
  automation: "Automatable" | "Manual review";
};

const LABS: LabItem[] = [
  { id: "responsive", name: "Responsive Lab", short: "Responsive", description: "Inspect mobile, tablet and desktop layouts, content overflow, image loading and screenshot evidence.", icon: MonitorSmartphone },
  { id: "functional", name: "Functional Lab", short: "Functional", description: "Inspect page controls, forms, fields, dropdowns, search and navigation structure.", icon: Code2 },
  { id: "visual", name: "Visual Testing", short: "Visual", description: "Capture stable full-page screenshots and compare staging with the live reference website.", icon: Eye, referenceLabel: "Live / reference website URL", referencePlaceholder: "https://www.live-website.com" },
  { id: "seo-geo", name: "SEO & GEO", short: "SEO & GEO", description: "Score technical SEO signals and GEO content/structured-data readiness out of 100.", icon: Search },
  { id: "performance", name: "Performance Lab", short: "Performance", description: "Measure browser timings, Core Web Vitals signals, image payloads and resource transfer.", icon: Gauge },
  { id: "accessibility", name: "Accessibility Lab", short: "Accessibility", description: "Run axe-core WCAG-related checks and summarize findings by impact severity.", icon: Accessibility },
  { id: "redirect-links", name: "Redirect & Link Lab", short: "Redirects & Links", description: "Compare staging URLs with the live website, verify permanent 301/308 redirects and inspect link health.", icon: Link2, referenceLabel: "Live website base URL (expected 301 destination)", referencePlaceholder: "https://www.live-website.com" },
];

const LAB_GUIDES: Record<LabId, { title: string; items: string[]; note: string }> = {
  responsive: {
    title: "What Responsive Lab checks",
    items: ["Mobile 390×844, tablet 768×1024 and desktop 1440×900 emulation.", "Horizontal overflow and viewport meta configuration.", "Header/footer landmarks and broken image detection.", "Waits for network settling, fonts, images and lazy-loaded content before full-page screenshots."],
    note: "Blank or incomplete screenshots are withheld and flagged. Screenshots show evidence; a QA engineer should still review visual details.",
  },
  functional: {
    title: "What Functional Lab checks",
    items: ["Button names, disabled states and interactive-control inventory.", "Form count, field labels, required fields and submit controls.", "Search boxes, dropdowns, filter/sort controls and navigation links.", "Link destinations and structural issues that may affect usability."],
    note: "This scan is read-only. It does not click buttons or submit forms because those actions may create real leads, send emails or change production data. End-to-end workflows need an approved staging test account.",
  },
  visual: {
    title: "What Visual Testing checks",
    items: ["Captures full-page screenshots after fonts, images and lazy-loaded content settle.", "Compares target and live reference pages at the same desktop viewport.", "Calculates raw pixel difference and reports a similarity score.", "Flags blank screenshots instead of presenting them as valid evidence."],
    note: "Dynamic inventory, ads, carousels, cookie banners and timestamps can create expected differences. Review screenshots before treating a pixel mismatch as a defect.",
  },
  "seo-geo": {
    title: "What SEO & GEO checks",
    items: ["Title, meta description, H1 structure and HTML language.", "Canonical URL, robots directives, X-Robots-Tag and sitemap availability.", "Hreflang and Open Graph metadata.", "JSON-LD structured data and answer-oriented heading signals."],
    note: "SEO and GEO scores are transparent internal heuristics, not proof of Google indexing, search ranking or AI answer visibility. Staging noindex rules may be intentional.",
  },
  performance: {
    title: "What Performance Lab checks",
    items: ["Time to First Byte and First Contentful Paint where available.", "Largest Contentful Paint and Cumulative Layout Shift signals.", "Total, JavaScript and image resource transfer sizes.", "Optional Lighthouse mobile category scores in supported local/Docker mode."],
    note: "A single browser visit is a lab measurement, not field-user data. INP is not claimed without representative user interaction. Lighthouse is disabled by default on Vercel until an isolated runner is configured.",
  },
  accessibility: {
    title: "What Accessibility Lab checks",
    items: ["axe-core rules tagged WCAG 2.0/2.1/2.2 A/AA and best practices.", "Critical, serious, moderate and minor violation impacts.", "Affected elements and example selectors.", "Automated checks that need manual keyboard and screen-reader follow-up."],
    note: "An automated score is a prioritization aid, not a WCAG conformance certificate. Keyboard-only and screen-reader testing remain necessary.",
  },
  "redirect-links": {
    title: "What Redirect & Link Lab checks",
    items: ["Captures the supplied staging URL's redirect chain.", "Checks whether the final URL matches the corresponding live URL.", "Verifies that internal staging links use permanent HTTP 301/308 redirects to matching live paths.", "Samples page links and reports broken, blocked or rate-limited destinations."],
    note: "Provide the staging URL in the main field and the live website base URL in the reference field. External links are checked for reachability, not expected to redirect to your live domain.",
  },
};

function summarizeChecks(checks: LabResult["checks"]) {
  return {
    total: checks.length,
    passed: checks.filter((item) => item.status === "PASS").length,
    failed: checks.filter((item) => item.status === "FAIL").length,
    warnings: checks.filter((item) => item.status === "WARNING").length,
    notChecked: checks.filter((item) => item.status === "NOT_CHECKED").length,
  };
}

function combineScores(existing: LabResult | null, batch: LabResult): LabResult["scores"] {
  const values = new Map<string, { sum: number; count: number; detail?: string }>();
  for (const score of existing?.scores || []) {
    values.set(score.label, { sum: score.value * (existing?.pagesScanned || 1), count: existing?.pagesScanned || 1, detail: score.detail });
  }
  for (const score of batch.scores || []) {
    const current = values.get(score.label) || { sum: 0, count: 0, detail: score.detail };
    current.sum += score.value;
    current.count += 1;
    values.set(score.label, current);
  }
  return Array.from(values.entries()).map(([label, item]) => ({
    label,
    value: Math.round(item.sum / Math.max(1, item.count)),
    detail: item.detail,
  }));
}

function combineBatch(existing: LabResult | null, batch: LabResult, allPages: string[], complete: boolean, warnings: string[], startedAt: string): LabResult {
  const reports = existing ? [existing, batch] : [batch];
  const checks = reports.flatMap((report) => report.checks);
  const screenshots = reports.flatMap((report) => report.screenshots).slice(0, 18);
  const logs = reports.flatMap((report) => report.logs || []).slice(-120);
  const notes = Array.from(new Set(reports.flatMap((report) => report.notes)));
  const metrics = reports.flatMap((report) => report.metrics || []);
  return {
    runId: existing?.runId || batch.runId,
    lab: batch.lab,
    url: batch.url,
    referenceUrl: batch.referenceUrl,
    startedAt,
    completedAt: batch.completedAt,
    durationMs: new Date(batch.completedAt).getTime() - new Date(startedAt).getTime(),
    finalUrl: existing?.finalUrl || batch.finalUrl,
    pageTitle: existing?.pageTitle || batch.pageTitle,
    pagesScanned: reports.reduce((sum, report) => sum + report.pagesScanned, 0),
    discoveredPages: allPages,
    crawlComplete: complete,
    crawlWarnings: warnings,
    logs,
    scores: combineScores(existing, batch),
    metrics,
    summary: summarizeChecks(checks),
    checks,
    screenshots,
    notes,
  };
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "PASS") return <CheckCircle2 size={16} />;
  if (status === "FAIL") return <XCircle size={16} />;
  if (status === "WARNING") return <CircleAlert size={16} />;
  return <Activity size={16} />;
}

function SummaryCard({ label, value, tone, icon: Icon }: { label: string; value: number; tone: string; icon: LucideIcon }) {
  return (
    <div className={`summary-card ${tone}`}>
      <div className="summary-card-top"><span>{label}</span><Icon size={17} /></div>
      <strong>{value}</strong>
    </div>
  );
}

function ScoreCard({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const tone = value >= 90 ? "good" : value >= 60 ? "average" : "poor";
  return (
    <div className={`score-card score-${tone}`}>
      <div className="score-ring" style={{ "--score": `${Math.max(0, Math.min(100, value)) * 3.6}deg` } as CSSProperties & { "--score": string }}>
        <div><strong>{value}</strong><span>/100</span></div>
      </div>
      <div className="score-copy"><strong>{label}</strong>{detail && <p>{detail}</p>}</div>
    </div>
  );
}

function DistributionChart({ result }: { result: LabResult }) {
  const { passed, failed, warnings, notChecked } = result.summary;
  const total = Math.max(1, passed + failed + warnings + notChecked);
  const p1 = passed / total * 100;
  const p2 = p1 + failed / total * 100;
  const p3 = p2 + warnings / total * 100;
  const gradient = `conic-gradient(#22c55e 0 ${p1}%, #ef4444 ${p1}% ${p2}%, #f59e0b ${p2}% ${p3}%, #64748b ${p3}% 100%)`;
  return (
    <div className="chart-card">
      <div className="chart-title"><div><h3>Result distribution</h3><p>How this audit's checks are distributed.</p></div><Activity size={17} /></div>
      <div className="donut-layout">
        <div className="donut-chart" style={{ background: gradient }}><div><strong>{total}</strong><span>checks</span></div></div>
        <div className="legend-list">
          <span><i className="legend-pass" /> Passed <b>{passed}</b></span>
          <span><i className="legend-fail" /> Failed <b>{failed}</b></span>
          <span><i className="legend-warning" /> Warnings <b>{warnings}</b></span>
          <span><i className="legend-muted" /> Not checked <b>{notChecked}</b></span>
        </div>
      </div>
    </div>
  );
}

function MetricBars({ metrics }: { metrics: LabMetric[] }) {
  const visible = metrics.filter((metric) => metric.value !== null).slice(0, 10);
  if (!visible.length) return null;
  const max = Math.max(1, ...visible.map((metric) => metric.value || 0));
  return (
    <div className="chart-card">
      <div className="chart-title"><div><h3>Performance metrics</h3><p>Measured browser values; bar lengths are relative within this report.</p></div><Gauge size={17} /></div>
      <div className="metric-bars">
        {visible.map((metric, index) => (
          <div className="metric-bar-row" key={`${metric.label}-${index}`}>
            <div className="metric-bar-label"><span>{metric.label}</span><strong>{metric.value?.toFixed(metric.unit === "MB" ? 2 : metric.unit === "" ? 3 : 0)} {metric.unit}</strong></div>
            <div className="metric-track"><span className={`metric-fill metric-${metric.status.toLowerCase()}`} style={{ width: `${Math.max(2, (metric.value || 0) / max * 100)}%` }} /></div>
            {metric.target && <small>Target: {metric.target}</small>}
          </div>
        ))}
      </div>
    </div>
  );
}


function SeverityChart({ checks }: { checks: LabResult["checks"] }) {
  const severities = [
    { label: "Critical", value: checks.filter((item) => item.severity === "critical" && item.status !== "PASS").length, color: "severity-critical-bar" },
    { label: "High", value: checks.filter((item) => item.severity === "high" && item.status !== "PASS").length, color: "severity-high-bar" },
    { label: "Medium", value: checks.filter((item) => item.severity === "medium" && item.status !== "PASS").length, color: "severity-medium-bar" },
    { label: "Low / Info", value: checks.filter((item) => (item.severity === "low" || item.severity === "info") && item.status !== "PASS").length, color: "severity-low-bar" },
  ];
  const max = Math.max(1, ...severities.map((item) => item.value));
  return (
    <div className="chart-card">
      <div className="chart-title"><div><h3>Accessibility issue severity</h3><p>Non-passing findings grouped by impact level.</p></div><Accessibility size={17}/></div>
      <div className="severity-chart">
        {severities.map((item) => <div className="severity-chart-row" key={item.label}><div><span>{item.label}</span><b>{item.value}</b></div><div className="metric-track"><span className={item.color} style={{width:`${item.value/max*100}%`}}/></div></div>)}
      </div>
    </div>
  );
}

function downloadJson(result: LabResult) {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `website-testing-${result.lab}-${new Date(result.completedAt).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function downloadCasesCsv(cases: TestCase[]) {
  const quote = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [
    ["ID", "Module", "Title", "Priority", "Preconditions", "Steps", "Expected Result", "Automation"],
    ...cases.map((item) => [item.id, item.module, item.title, item.priority, item.preconditions, item.steps.join(" | "), item.expected, item.automation]),
  ];
  const csv = rows.map((row) => row.map(quote).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "website-test-cases.csv";
  anchor.click();
  URL.revokeObjectURL(href);
}

export function AppShell() {
  const [selectedLab, setSelectedLab] = useState<LabId>("responsive");
  const selectedLabRef = useRef<LabId>("responsive");
  const [activeView, setActiveView] = useState<"dashboard" | "lab" | "test-cases">("dashboard");
  const [url, setUrl] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [result, setResult] = useState<LabResult | null>(null);
  const [resultsByLab, setResultsByLab] = useState<Partial<Record<LabId, LabResult>>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyMode, setHistoryMode] = useState<"local" | "shared">("local");
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"ALL" | CheckStatus>("ALL");
  const [progress, setProgress] = useState<{ phase: string; completed: number; total: number; logs: string[] }>({ phase: "", completed: 0, total: 0, logs: [] });
  const [caseUrl, setCaseUrl] = useState("");
  const [caseInstruction, setCaseInstruction] = useState("");
  const [caseLanguage, setCaseLanguage] = useState<"English" | "French">("English");
  const [caseLoading, setCaseLoading] = useState(false);
  const [caseError, setCaseError] = useState("");
  const [generatedCases, setGeneratedCases] = useState<TestCase[]>([]);
  const [caseMode, setCaseMode] = useState("");
  const [caseSummary, setCaseSummary] = useState<{ forms: number; buttons: number; links: number; dropdowns: number; images: number } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      let localReports: StoredLabResult[] = [];
      try { localReports = await getStoredReports(); } catch {}
      let sharedItems: HistoryEntry[] = [];
      let sharedEnabled = false;
      try {
        const response = await fetch("/api/history", { cache: "no-store" });
        if (response.ok) {
          const payload = await response.json();
          if (payload.enabled && Array.isArray(payload.items)) {
            sharedEnabled = true;
            sharedItems = payload.items as HistoryEntry[];
          }
        }
      } catch {}

      if (!active) return;
      const localItems: HistoryEntry[] = localReports.map((report) => ({
        runId: report.runId,
        lab: report.lab,
        url: report.url,
        referenceUrl: report.referenceUrl,
        completedAt: report.completedAt,
        pagesScanned: report.pagesScanned,
        summary: report.summary,
        scores: report.scores,
        report,
      }));
      const knownIds = new Set(sharedItems.map((item) => item.runId));
      const combined = [...sharedItems, ...localItems.filter((item) => !knownIds.has(item.runId))]
        .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
        .slice(0, 100);
      const latest: Partial<Record<LabId, LabResult>> = {};
      for (const report of localReports) {
        if (!latest[report.lab]) latest[report.lab] = report;
      }
      setHistory(combined);
      setHistoryMode(sharedEnabled ? "shared" : "local");
      setResultsByLab(latest);
      setHydrated(true);
      if (localReports[0]) setUrl(localReports[0].url);
      else if (sharedItems[0]) setUrl(sharedItems[0].url);
    })();
    return () => { active = false; };
  }, []);

  const currentLab = LABS.find((lab) => lab.id === selectedLab) || LABS[0];
  const Icon = currentLab.icon;
  const filteredChecks = useMemo(
    () => result?.checks.filter((check) => filter === "ALL" || check.status === filter) || [],
    [result, filter]
  );

  async function loadHistoryReport(item: HistoryEntry): Promise<StoredLabResult | null> {
    if (item.report) return item.report;
    try {
      const response = await fetch(`/api/history/${encodeURIComponent(item.runId)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load this saved report.");
      const report = payload.data as StoredLabResult;
      setResultsByLab((previous) => ({ ...previous, [report.lab]: report }));
      setHistory((previous) => previous.map((entry) => entry.runId === item.runId ? { ...entry, report } : entry));
      return report;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this saved report.");
      return null;
    }
  }

  async function chooseLab(lab: LabId) {
    selectedLabRef.current = lab;
    setSelectedLab(lab);
    setActiveView("lab");
    setError("");
    setFilter("ALL");
    setReferenceUrl("");
    setProgress({ phase: "", completed: 0, total: 0, logs: [] });
    const cached = resultsByLab[lab];
    if (cached) {
      setResult(cached);
      return;
    }
    const latest = history.find((item) => item.lab === lab);
    if (latest) {
      const report = await loadHistoryReport(latest);
      if (selectedLabRef.current === lab) {
        if (report) setResult(report);
        else setResult(null);
      }
    } else {
      setResult(null);
    }
  }

  async function openReport(item: HistoryEntry) {
    selectedLabRef.current = item.lab;
    setSelectedLab(item.lab);
    setActiveView("lab");
    setUrl(item.url);
    setReferenceUrl(item.referenceUrl || "");
    setFilter("ALL");
    setError("");
    const report = await loadHistoryReport(item);
    if (selectedLabRef.current === item.lab && report) setResult(report);
  }

  async function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFilter("ALL");
    setLoading(true);
    const runningLab = selectedLab;
    const startedAt = new Date().toISOString();
    let aggregate: LabResult | null = null;
    const runId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}`;
    const logLines: string[] = ["Validating the target URL.", "Discovering sitemap URLs and same-origin internal links."];
    setProgress({ phase: "Discovering pages", completed: 0, total: 0, logs: logLines });

    try {
      const discoveryResponse = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const discoveryPayload = await discoveryResponse.json();
      if (!discoveryResponse.ok) throw new Error(discoveryPayload.error || "Could not discover website pages.");
      const discovery = discoveryPayload.data as { pages: string[]; warnings: string[]; complete: boolean; durationMs: number; source: string };
      const pages = discovery.pages || [];
      if (!pages.length) throw new Error("No pages could be discovered for this website.");
      logLines.push(`Discovery completed in ${(discovery.durationMs / 1000).toFixed(1)}s. ${pages.length} page(s) found via ${discovery.source}.`);
      if (discovery.warnings?.length) logLines.push(...discovery.warnings);
      setProgress({ phase: "Testing pages", completed: 0, total: pages.length, logs: [...logLines] });

      // Keep each request bounded. Performance, full-page visual and redirect checks run one page per request.
      const batchSize = ["performance", "visual", "redirect-links"].includes(runningLab) ? 1 : 4;
      for (let offset = 0; offset < pages.length; offset += batchSize) {
        const batch = pages.slice(offset, offset + batchSize);
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lab: runningLab,
            url: url.trim(),
            referenceUrl: referenceUrl.trim() || undefined,
            pages: batch,
            crawlComplete: offset === 0 ? discovery.complete : true,
            crawlWarnings: offset === 0 ? discovery.warnings : [],
            totalDiscovered: pages.length,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Testing batch ${Math.floor(offset / batchSize) + 1} failed.`);
        const batchResult = payload.data as LabResult;
        aggregate = combineBatch(aggregate, batchResult, pages, discovery.complete, discovery.warnings, startedAt);
        aggregate.runId = runId;
        logLines.push(...(batchResult.logs || []));
        logLines.push(`Batch ${Math.floor(offset / batchSize) + 1}: ${Math.min(offset + batch.length, pages.length)}/${pages.length} pages processed.`);
        setProgress({
          phase: "Testing pages",
          completed: Math.min(offset + batch.length, pages.length),
          total: pages.length,
          logs: [...logLines].slice(-100),
        });
        setResultsByLab((previous) => ({ ...previous, [runningLab]: aggregate! }));
        if (selectedLabRef.current === runningLab) setResult(aggregate);
      }

      if (!aggregate) throw new Error("The audit did not return any results.");
      aggregate.runId = runId;
      aggregate.completedAt = new Date().toISOString();
      aggregate.durationMs = new Date(aggregate.completedAt).getTime() - new Date(startedAt).getTime();
      aggregate.logs = [...logLines, "Audit completed. Results saved to report history."].slice(-120);
      if (selectedLabRef.current === runningLab) setResult(aggregate);
      setResultsByLab((previous) => ({ ...previous, [runningLab]: aggregate! }));
      const stored = { ...aggregate, screenshots: aggregate.screenshots.slice(0, 4) } as StoredLabResult;
      try {
        await saveStoredReport(stored);
      } catch {
        setError("Audit completed, but browser storage could not save the report. Download the PDF or JSON before leaving this page.");
      }
      let sharedSaved = false;
      try {
        const sharedResponse = await fetch("/api/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report: { ...aggregate, screenshots: [] } }),
        });
        const sharedPayload = await sharedResponse.json();
        sharedSaved = Boolean(sharedResponse.ok && sharedPayload.enabled && sharedPayload.saved);
        if (sharedSaved) setHistoryMode("shared");
        else if (sharedPayload.error) setError(`Audit completed and saved locally, but shared history could not be saved: ${sharedPayload.error}`);
      } catch {
        // The browser-local IndexedDB copy remains available if the shared database is unreachable.
      }
      const historyItem: HistoryEntry = {
        runId,
        lab: aggregate.lab,
        url: aggregate.url,
        referenceUrl: aggregate.referenceUrl,
        completedAt: aggregate.completedAt,
        pagesScanned: aggregate.pagesScanned,
        summary: aggregate.summary,
        scores: aggregate.scores,
        report: stored,
      };
      const updatedHistory = [historyItem, ...history.filter((item) => item.runId !== runId)].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 100);
      setHistory(updatedHistory);
      setProgress({ phase: "Completed", completed: pages.length, total: pages.length, logs: aggregate.logs || [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(message);
      if (aggregate) {
        aggregate.logs = [...logLines, `Run stopped early: ${message}`];
        aggregate.crawlComplete = false;
        setResultsByLab((previous) => ({ ...previous, [runningLab]: aggregate! }));
        if (selectedLabRef.current === runningLab) setResult(aggregate);
        try {
          const partial = { ...aggregate, screenshots: aggregate.screenshots.slice(0, 4) } as StoredLabResult;
          await saveStoredReport(partial);
          const partialItem: HistoryEntry = {
            runId: partial.runId, lab: partial.lab, url: partial.url, referenceUrl: partial.referenceUrl,
            completedAt: partial.completedAt, pagesScanned: partial.pagesScanned, summary: partial.summary,
            scores: partial.scores, report: partial,
          };
          setHistory((previous) => [partialItem, ...previous.filter((item) => item.runId !== partial.runId)].slice(0, 100));
        } catch {}
      }
    } finally {
      setLoading(false);
    }
  }

  async function generateTestCases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCaseLoading(true);
    setCaseError("");
    setGeneratedCases([]);
    try {
      const response = await fetch("/api/test-cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: caseUrl.trim(), instruction: caseInstruction.trim(), language: caseLanguage }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Test case generation failed.");
      setGeneratedCases(payload.data.cases || []);
      setCaseMode(payload.data.generationMode || "Rule-based");
      setCaseSummary(payload.data.inventorySummary || null);
    } catch (err) {
      setCaseError(err instanceof Error ? err.message : "Test case generation failed.");
    } finally {
      setCaseLoading(false);
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
    window.location.reload();
  }

  const uniqueSites = new Set(history.map((item) => {
    try { return new URL(item.url).origin; } catch { return item.url; }
  })).size;
  const totalRuns = history.length;
  const totalFails = history.reduce((sum, item) => sum + item.summary.failed, 0);
  const activeTitle = activeView === "dashboard" ? "Dashboard" : activeView === "test-cases" ? "Test Case Generator" : currentLab.name;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><FlaskConical size={21} /></div>
          <div><strong>WEB QA</strong><span>TESTING LABS</span></div>
        </div>

        <button type="button" className={`nav-item overview-nav ${activeView === "dashboard" ? "active" : ""}`} onClick={() => setActiveView("dashboard")}>
          <LayoutDashboard size={18} /><span>Dashboard</span>
        </button>
        <div className="sidebar-label">TESTING LABS</div>
        <nav className="lab-nav" aria-label="Testing labs">
          {LABS.map((lab) => {
            const LabIcon = lab.icon;
            const active = activeView === "lab" && selectedLab === lab.id;
            return (
              <button key={lab.id} type="button" className={`nav-item ${active ? "active" : ""}`} onClick={() => chooseLab(lab.id)} aria-current={active ? "page" : undefined}>
                <LabIcon size={18} strokeWidth={1.9} />
                <span>{lab.name}</span>
                {active && <ChevronRight className="nav-chevron" size={15} />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-label tools-label">TOOLS</div>
        <button type="button" className={`nav-item ${activeView === "test-cases" ? "active" : ""}`} onClick={() => setActiveView("test-cases")}>
          <ListChecks size={18} /><span>Test Case Generator</span>
        </button>

        <div className="sidebar-bottom">
          <div className="sidebar-status"><span className="online-dot" /> Playwright engine configured</div>
          <button type="button" className="logout-button" onClick={logout}><LogOut size={16} /> Sign out</button>
          <div className="sidebar-version">WEBSITE TESTING LABS <span>v1.1</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{activeTitle}</strong></div>
          <div className="topbar-right"><span className="private-pill"><ShieldCheck size={13} /> QA workspace</span><div className="avatar">QA</div></div>
        </header>

        <div className="content-wrap">
          {activeView === "dashboard" && (
            <section className="dashboard-view">
              <div className="page-heading">
                <div><p className="eyebrow">QUALITY INTELLIGENCE OVERVIEW</p><h1>QA Dashboard</h1><p className="page-subtitle">Your recent website audits, saved reports and testing activity.</p></div>
                <div className="heading-mark"><LayoutDashboard size={25} /></div>
              </div>
              <div className="dashboard-stats">
                <div className="dashboard-stat"><span>Websites checked</span><strong>{uniqueSites}</strong><Globe2 size={18} /></div>
                <div className="dashboard-stat"><span>Saved audits</span><strong>{totalRuns}</strong><History size={18} /></div>
                <div className="dashboard-stat"><span>Failed checks</span><strong>{totalFails}</strong><XCircle size={18} /></div>
                <div className="dashboard-stat"><span>Available labs</span><strong>7</strong><FlaskConical size={18} /></div>
              </div>
              <div className="dashboard-section-heading"><div><h2>Recent website audits</h2><p>Reports are saved in this browser and remain available when switching labs.</p></div><button type="button" className="secondary-button" onClick={() => setActiveView("lab")}><Zap size={15} /> Start a new audit</button></div>
              {!hydrated ? (
                <div className="empty-state dashboard-empty"><div className="empty-icon"><LoaderCircle className="spin" size={25}/></div><h2>Loading report history</h2><p>Checking this browser's saved reports and shared team history.</p></div>
              ) : history.length === 0 ? (
                <div className="empty-state dashboard-empty"><div className="empty-icon"><History size={27} /></div><h2>No saved audits yet</h2><p>Run your first website check. The result will appear here and remain available when you switch between labs.</p><button className="primary-button" onClick={() => chooseLab("responsive")}><MonitorSmartphone size={16} /> Open Responsive Lab</button></div>
              ) : (
                <div className="history-list">
                  {history.map((item) => {
                    const LabIcon = LABS.find((lab) => lab.id === item.lab)?.icon || FileText;
                    return (
                      <button type="button" className="history-row" key={item.runId} onClick={() => openReport(item)}>
                        <div className="history-lab-icon"><LabIcon size={18} /></div>
                        <div className="history-main"><strong>{item.url}</strong><span>{item.lab.toUpperCase()} · {new Date(item.completedAt).toLocaleString()}</span></div>
                        <div className="history-counts"><span className="history-pass">✓ {item.summary.passed}</span><span className="history-fail">✕ {item.summary.failed}</span><span className="history-warning">! {item.summary.warnings}</span></div>
                        <div className="history-pages">{item.pagesScanned} pages</div><ChevronRight size={17} />
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="dashboard-note"><ShieldCheck size={16} /><p>{historyMode === "shared" ? "Shared team history is enabled through PostgreSQL/Neon. Report checks and scores are shared across users; screenshots remain in the browser that generated them." : "History is stored locally in this browser using IndexedDB. Add DATABASE_URL to enable shared team history across browsers and devices."}</p></div>
            </section>
          )}

          {activeView === "test-cases" && (
            <section className="testcase-view">
              <div className="page-heading"><div><p className="eyebrow">QA PRODUCTIVITY TOOL</p><h1>Test Case Generator</h1><p className="page-subtitle">Inspect a website's visible UI and generate a structured first draft of manual and automation test cases.</p></div><div className="heading-mark"><WandSparkles size={25} /></div></div>
              <section className="run-panel">
                <div className="panel-heading"><div className="panel-icon"><ListChecks size={18} /></div><div><h2>Generate website test cases</h2><p>Provide a URL and optional requirements or focus areas.</p></div></div>
                <form className="run-form" onSubmit={generateTestCases}>
                  <label className="field-label"><span>Website URL <b>Required</b></span><div className="url-input-wrap"><Globe2 size={17} /><input type="url" required value={caseUrl} onChange={(event) => setCaseUrl(event.target.value)} placeholder="https://www.example.com" /></div></label>
                  <label className="field-label"><span>Additional instructions (optional)</span><textarea className="instruction-input" value={caseInstruction} onChange={(event) => setCaseInstruction(event.target.value)} placeholder="Example: Focus on inventory filters, lead forms, English/French language switching and mobile navigation." rows={3} /></label>
                  <label className="field-label"><span>Test case language</span><select className="language-select" value={caseLanguage} onChange={(event) => setCaseLanguage(event.target.value as "English" | "French")}><option>English</option><option>French</option></select></label>
                  <div className="run-form-footer"><div className="run-safety-note"><ShieldCheck size={15} /> Read-only UI discovery · Does not submit forms</div><button className="primary-button run-button" type="submit" disabled={caseLoading || !caseUrl.trim()}>{caseLoading ? <><LoaderCircle className="spin" size={17} /> Generating…</> : <><WandSparkles size={16} /> Generate test cases</>}</button></div>
                </form>
                {caseError && <div className="error-banner"><CircleAlert size={17} />{caseError}</div>}
              </section>
              {generatedCases.length > 0 && (
                <section className="generated-cases">
                  <div className="results-heading"><div><p className="eyebrow">GENERATED TEST SUITE</p><h2>{generatedCases.length} test cases generated</h2><p className="result-url">{caseMode}</p></div><button className="secondary-button" onClick={() => downloadCasesCsv(generatedCases)}><Download size={15} /> Export CSV</button></div>
                  {caseSummary && <div className="case-inventory-summary"><span>{caseSummary.forms} forms</span><span>{caseSummary.buttons} buttons</span><span>{caseSummary.links} links</span><span>{caseSummary.dropdowns} dropdowns</span><span>{caseSummary.images} images</span></div>}
                  <div className="case-list">{generatedCases.map((item) => <article className="case-card" key={item.id}><div className="case-card-head"><span>{item.id} · {item.module}</span><b className={`priority-${item.priority.toLowerCase()}`}>{item.priority}</b></div><h3>{item.title}</h3><p><strong>Preconditions:</strong> {item.preconditions}</p><p><strong>Steps:</strong></p><ol>{item.steps.map((step,index)=><li key={index}>{step}</li>)}</ol><p><strong>Expected result:</strong> {item.expected}</p><span className="automation-tag">{item.automation}</span></article>)}</div>
                  <div className="report-notes"><h3>Generation note</h3><p>These cases are generated from the visible page structure and your instructions. They are proposed test cases, not executed test results. Confirm business requirements and expected outcomes before using them for sign-off.</p></div>
                </section>
              )}
            </section>
          )}

          {activeView === "lab" && (
            <>
              <section className="page-heading">
                <div><p className="eyebrow">AUTOMATED WEBSITE QUALITY</p><h1>{currentLab.name}</h1><p className="page-subtitle">{currentLab.description}</p></div>
                <div className="heading-mark"><Icon size={25} /></div>
              </section>

              <section className="instruction-panel">
                <div className="instruction-icon"><ClipboardList size={18} /></div>
                <div className="instruction-content"><h2>{LAB_GUIDES[selectedLab].title}</h2><ul>{LAB_GUIDES[selectedLab].items.map((item,index)=><li key={index}>{item}</li>)}</ul><p>{LAB_GUIDES[selectedLab].note}</p></div>
              </section>

              <section className="run-panel">
                <div className="panel-heading"><div className="panel-icon"><Globe2 size={18} /></div><div><h2>Start a website test</h2><p>Enter a website URL. The crawler discovers sitemap entries and same-origin links automatically.</p></div></div>
                <form onSubmit={runTest} className="run-form">
                  <label className="field-label"><span>{selectedLab === "redirect-links" ? "Staging / source website URL" : "Website URL"} <b>Required</b></span><div className="url-input-wrap"><Globe2 size={17} /><input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://staging.example.com" /></div></label>
                  {currentLab.referenceLabel && <label className="field-label"><span>{currentLab.referenceLabel}</span><div className="url-input-wrap"><ArrowDownUp size={17} /><input type="url" value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder={currentLab.referencePlaceholder} /></div><small>{selectedLab === "visual" ? "The live page is used as the visual baseline. Matching paths are compared across the two websites." : "The same path on the live domain is treated as the expected permanent redirect destination."}</small></label>}
                  <div className="crawl-explainer"><Globe2 size={15} /><div><strong>Automatic full-site discovery</strong><span>Reads sitemap.xml / robots.txt and follows discoverable same-origin links. No page-count field is needed.</span></div></div>
                  <div className="run-form-footer"><div className="run-safety-note"><ShieldCheck size={15} /> Authorized public websites · Safe read-only checks</div><button className="primary-button run-button" type="submit" disabled={loading || !url.trim()}>{loading ? <><LoaderCircle className="spin" size={17} /> {progress.phase || "Running lab…"}</> : <><Zap size={17} /> Run full-site test <ArrowRight size={16} /></>}</button></div>
                </form>
                {error && <div className="error-banner"><CircleAlert size={17} /><span>{error}</span></div>}
                {loading && <div className="progress-panel"><div className="progress-heading"><strong>{progress.phase}</strong><span>{progress.completed}/{progress.total || "—"} pages</span></div><div className="progress-track"><span style={{ width: `${progress.total ? Math.min(100, progress.completed / progress.total * 100) : 8}%` }} /></div><div className="progress-logs">{progress.logs.slice(-8).map((line,index)=><p key={`${line}-${index}`}><Activity size={12}/>{line}</p>)}</div></div>}
              </section>

              {!result && !loading && <section className="empty-state"><div className="empty-icon"><Icon size={27} /></div><h2>{resultsByLab[selectedLab] ? "Previous results are saved" : "Ready when you are"}</h2><p>{resultsByLab[selectedLab] ? "Your previous report is retained. Run another test to update it." : `Your ${currentLab.short.toLowerCase()} results will appear here after the test completes.`}</p><div className="empty-hints"><span><CheckCircle2 size={14}/> Evidence-based checks</span><span><ShieldCheck size={14}/> Safe read-only execution</span><span><ClipboardList size={14}/> PDF and JSON reports</span></div></section>}

              {result && (
                <section className="results-section">
                  <div className="results-heading"><div><p className="eyebrow">TEST REPORT</p><h2>Results overview</h2><p className="result-url">{result.finalUrl || result.url}</p></div><div className="report-actions"><button type="button" className="secondary-button" onClick={() => downloadLabPdf(result)}><FileText size={15}/> Download PDF</button><button type="button" className="secondary-button" onClick={() => downloadJson(result)}><Download size={15}/> JSON</button></div></div>

                  {result.scores?.length ? <div className="scores-grid">{result.scores.map((score,index)=><ScoreCard key={`${score.label}-${index}`} {...score}/>)}</div> : null}
                  <div className="summary-grid"><SummaryCard label="Passed" value={result.summary.passed} tone="summary-pass" icon={CheckCircle2}/><SummaryCard label="Failed" value={result.summary.failed} tone="summary-fail" icon={XCircle}/><SummaryCard label="Warnings" value={result.summary.warnings} tone="summary-warning" icon={CircleAlert}/><SummaryCard label="Not checked" value={result.summary.notChecked} tone="summary-neutral" icon={Activity}/></div>
                  <div className="report-meta"><span><span className="meta-dot"/> {result.checks.length} checks</span><span>{result.pagesScanned}/{result.discoveredPages.length} pages tested</span><span>Duration: {(result.durationMs/1000).toFixed(1)}s</span><span>{result.crawlComplete === false ? "Crawl incomplete" : "Crawl complete"}</span></div>
                  {result.crawlComplete === false && <div className="error-banner"><CircleAlert size={16}/><span>The crawler could not confirm complete page discovery. Review the warnings before treating this as a full-site sign-off.</span></div>}
                  <div className="visualization-grid">
                    <DistributionChart result={result}/>
                    {result.metrics?.length ? <MetricBars metrics={result.metrics}/> : <div className="chart-card"><div className="chart-title"><div><h3>Audit coverage</h3><p>Pages discovered and processed in this report.</p></div><Globe2 size={17}/></div><div className="coverage-number">{result.pagesScanned}<span> / {result.discoveredPages.length}</span></div><div className="metric-track"><span className="metric-fill metric-pass" style={{width:`${result.discoveredPages.length ? result.pagesScanned/result.discoveredPages.length*100 : 0}%`}}/></div><p className="coverage-note">Page coverage for this lab run.</p></div>}
                    {selectedLab === "accessibility" ? <SeverityChart checks={result.checks}/> : null}
                  </div>

                  {result.logs?.length ? <details className="execution-logs"><summary><span><Activity size={15}/> Execution log</span><span>{result.logs.length} entries</span></summary><div>{result.logs.map((line,index)=><p key={index}><span>{String(index+1).padStart(2,"0")}</span>{line}</p>)}</div></details> : null}
                  <details className="scanned-pages"><summary><strong>Pages included in this run ({result.discoveredPages.length})</strong><ChevronRight size={15}/></summary>{result.discoveredPages.map((page,index)=><a key={`${page}-${index}`} href={page} target="_blank" rel="noreferrer"><ExternalLink size={12}/>{page}</a>)}</details>

                  {result.screenshots.length > 0 && <div className="evidence-section"><div className="section-title"><div><h3>Visual evidence</h3><p>Stable screenshots captured during this run.</p></div><ImageIcon size={18}/></div><div className="evidence-grid">{result.screenshots.map((shot,index)=><figure className="evidence-card" key={`${shot.label}-${index}`}><img src={shot.dataUrl} alt={shot.label}/><figcaption>{shot.label}</figcaption></figure>)}</div></div>}

                  <div className="checks-section"><div className="section-title"><div><h3>Test results</h3><p>Each result includes expected behavior, observed behavior and a recommendation.</p></div><ClipboardList size={18}/></div>
                    <div className="filter-row">{(["ALL","PASS","FAIL","WARNING","NOT_CHECKED"] as const).map((status)=><button key={status} type="button" onClick={()=>setFilter(status)} className={`filter-chip ${filter===status?"selected":""}`}>{status==="ALL"?`All (${result.checks.length})`:`${status.replace("_"," ")} (${result.checks.filter((check)=>check.status===status).length})`}</button>)}</div>
                    <div className="check-list">{filteredChecks.map((check,index)=><article className="check-card" key={`${check.id}-${index}`}><div className={`check-status status-${check.status.toLowerCase()}`}><StatusIcon status={check.status}/><span>{check.status.replace("_"," ")}</span></div><div className="check-content"><div className="check-title-row"><h4>{check.name}</h4><span className={`severity severity-${check.severity}`}>{check.severity}</span></div><div className="check-detail-grid"><div><span>Expected</span><p>{check.expected}</p></div><div><span>Actual</span><p>{check.actual}</p></div></div>{check.recommendation&&<div className="recommendation"><Sparkles size={14}/><p>{check.recommendation}</p></div>}{check.pageUrl&&<a className="check-page-link" href={check.pageUrl} target="_blank" rel="noreferrer"><ExternalLink size={12}/> Open affected page</a>}</div></article>)}{filteredChecks.length===0&&<div className="no-results">No checks match this filter.</div>}</div>
                  </div>
                  {result.notes.length>0&&<div className="report-notes"><h3>Scope and limitations</h3>{result.notes.map((note,index)=><p key={index}>• {note}</p>)}</div>}
                </section>
              )}
            </>
          )}

          <footer className="page-footer"><span>Website Testing Labs</span><span>Responsive QA workspace · Playwright powered</span></footer>
        </div>
      </main>
    </div>
  );
}
