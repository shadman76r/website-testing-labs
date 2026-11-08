import type { Browser } from "playwright";
import type { LabCheck, LabMetric, LabScore } from "@/lib/types";
import { createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck, statusForThreshold } from "./shared";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export async function runPerformanceLab(browser: Browser, url: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const metricsForChart: LabMetric[] = [];
  const scores: LabScore[] = [];
  const logs: string[] = [];
  const context = await createSafeContext(browser, undefined, {}, inferLocale(url));
  let finalUrl = "";
  let pageTitle = "";

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const state = { lcp: null as number | null, cls: 0 };
      (window as any).__wtlPerf = state;
      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as any;
          if (last) state.lcp = last.startTime;
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {}
      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as any[]) {
            if (!entry.hadRecentInput) state.cls += entry.value || 0;
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {}
    });
    const response = await navigate(page, url);
    await page.waitForTimeout(900);
    const identity = await pageIdentity(page);
    finalUrl = identity.url;
    pageTitle = identity.title;

    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const paints = performance.getEntriesByType("paint");
      const fcp = paints.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null;
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const jsResources = resources.filter((entry) => /\.m?js(?:$|\?)/i.test(entry.name));
      const transfer = resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
      const jsTransfer = jsResources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0);
      const images = Array.from(document.images);
      const perf = (window as any).__wtlPerf || {};
      return {
        ttfb: nav ? nav.responseStart - nav.requestStart : null,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
        fcp,
        lcp: typeof perf.lcp === "number" ? perf.lcp : null,
        cls: typeof perf.cls === "number" ? perf.cls : null,
        transferBytes: transfer,
        jsTransferBytes: jsTransfer,
        resourceCount: resources.length,
        jsCount: jsResources.length,
        imageCount: images.length,
        imageBytes: resources.filter((entry) => /\.(?:png|jpe?g|webp|avif|gif)(?:$|\?)/i.test(entry.name)).reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      };
    });

    const metricsToCheck = [
      { id: "PERF-TTFB", name: "Time to First Byte", value: metrics.ttfb, good: 800, poor: 1800, unit: "ms", target: "≤ 800 ms", expected: "≤ 800 ms is a good target." },
      { id: "PERF-FCP", name: "First Contentful Paint", value: metrics.fcp, good: 1800, poor: 3000, unit: "ms", target: "≤ 1,800 ms", expected: "≤ 1,800 ms is a good target." },
      { id: "PERF-LCP", name: "Largest Contentful Paint", value: metrics.lcp, good: 2500, poor: 4000, unit: "ms", target: "≤ 2,500 ms", expected: "≤ 2,500 ms is a good target. The browser observer may not expose LCP in every run." },
      { id: "PERF-CLS", name: "Cumulative Layout Shift", value: metrics.cls, good: 0.1, poor: 0.25, unit: "", target: "≤ 0.10", expected: "≤ 0.10 is a good target. CLS requires a suitable page lifecycle window." },
    ];

    for (const metric of metricsToCheck) {
      const status = metric.value === null ? "NOT_CHECKED" : statusForThreshold(metric.value, metric.good, metric.poor);
      metricsForChart.push({ label: metric.name, value: metric.value, unit: metric.unit, status, target: metric.target });
      pushCheck(checks, {
        id: metric.id,
        name: metric.name,
        status,
        severity: metric.id === "PERF-LCP" ? "high" : "medium",
        expected: metric.expected,
        actual: metric.value === null ? "Metric was not available in this browser visit." : `${metric.value.toFixed(metric.id === "PERF-CLS" ? 3 : 0)}${metric.unit ? ` ${metric.unit}` : ""}.`,
        recommendation: status === "FAIL" || status === "WARNING" ? "Investigate server response time, render-blocking assets, image dimensions, layout shifts and third-party scripts." : undefined,
        pageUrl: identity.url,
      });
    }

    pushCheck(checks, {
      id: "PERF-TRANSFER",
      name: "Transferred resource size",
      status: metrics.transferBytes > 3_000_000 ? "WARNING" : "PASS",
      severity: "medium",
      expected: "Keep initial transferred resources lean; 3 MB is a review threshold in this lab.",
      actual: `${formatBytes(metrics.transferBytes)} across ${metrics.resourceCount} resources.`,
      recommendation: metrics.transferBytes > 3_000_000 ? "Review image formats, font files, JavaScript bundles and third-party resources." : undefined,
      pageUrl: identity.url,
    });
    metricsForChart.push({ label: "Total transferred", value: metrics.transferBytes / 1024 / 1024, unit: "MB", status: metrics.transferBytes > 3_000_000 ? "WARNING" : "PASS", target: "≤ 3 MB" });

    pushCheck(checks, {
      id: "PERF-JAVASCRIPT",
      name: "JavaScript transfer size",
      status: metrics.jsTransferBytes > 1_500_000 ? "WARNING" : "PASS",
      severity: "medium",
      expected: "Avoid unnecessarily large JavaScript payloads; 1.5 MB is a review threshold.",
      actual: `${formatBytes(metrics.jsTransferBytes)} across ${metrics.jsCount} JavaScript resources.`,
      recommendation: metrics.jsTransferBytes > 1_500_000 ? "Consider code splitting, removing unused packages and deferring non-critical scripts." : undefined,
      pageUrl: identity.url,
    });
    metricsForChart.push({ label: "JavaScript transfer", value: metrics.jsTransferBytes / 1024 / 1024, unit: "MB", status: metrics.jsTransferBytes > 1_500_000 ? "WARNING" : "PASS", target: "≤ 1.5 MB" });

    pushCheck(checks, {
      id: "PERF-IMAGE-TRANSFER",
      name: "Image transfer size",
      status: metrics.imageBytes > 2_000_000 ? "WARNING" : "PASS",
      severity: "medium",
      expected: "Optimize large image payloads and serve responsive image sizes.",
      actual: `${formatBytes(metrics.imageBytes)} transferred by image resources across ${metrics.imageCount} image element(s).`,
      recommendation: metrics.imageBytes > 2_000_000 ? "Use AVIF/WebP where appropriate, responsive srcset sizes, compression and lazy loading for below-the-fold images." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "PERF-INP",
      name: "Interaction to Next Paint",
      status: "NOT_CHECKED",
      severity: "info",
      expected: "INP is measured from representative real user interaction latency.",
      actual: "Not measured because this read-only run does not generate representative user interactions.",
      recommendation: "Use field data (CrUX/RUM) or an approved interaction journey for reliable INP measurement.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "PERF-HTTP",
      name: "Page HTTP response",
      status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : "PASS",
      severity: "high",
      expected: "Page returns a successful HTTP response.",
      actual: response ? `HTTP ${response.status()}.` : "No main-document HTTP response was available.",
      pageUrl: identity.url,
    });

    // Lighthouse is an optional local/Docker add-on. It is disabled by default on Vercel
    // until a network-isolated Chrome runner is configured for that deployment.
    if (process.env.ENABLE_LIGHTHOUSE === "true" && process.env.LIGHTHOUSE_ALLOW_UNFILTERED_NETWORK === "true" && !process.env.VERCEL) {
      logs.push("Starting optional Lighthouse mobile audit.");
      try {
        const { runLighthouseAudit } = await import("./lighthouse");
        const lighthouseResult = await runLighthouseAudit(identity.url);
        for (const category of lighthouseResult.categories) {
          scores.push({ label: `Lighthouse ${category.title}`, value: category.score, detail: "Mobile Lighthouse category score." });
          const status = category.score >= 90 ? "PASS" : category.score >= 50 ? "WARNING" : "FAIL";
          pushCheck(checks, {
            id: `LIGHTHOUSE-${category.id.toUpperCase()}`,
            name: `Lighthouse ${category.title} score`,
            status,
            severity: category.score < 50 ? "high" : "medium",
            expected: "A Lighthouse category score of 90 or above is considered good.",
            actual: `${category.score}/100.`,
            recommendation: category.score < 90 ? "Open the Lighthouse audit details and prioritize the failing opportunities and diagnostics." : undefined,
            pageUrl: identity.url,
          });
        }
        if (typeof lighthouseResult.lcpMs === "number") metricsForChart.push({ label: "Lighthouse LCP", value: lighthouseResult.lcpMs, unit: "ms", status: statusForThreshold(lighthouseResult.lcpMs, 2500, 4000), target: "≤ 2,500 ms" });
        if (typeof lighthouseResult.tbtMs === "number") metricsForChart.push({ label: "Total Blocking Time", value: lighthouseResult.tbtMs, unit: "ms", status: statusForThreshold(lighthouseResult.tbtMs, 200, 600), target: "≤ 200 ms" });
        if (typeof lighthouseResult.cls === "number") metricsForChart.push({ label: "Lighthouse CLS", value: lighthouseResult.cls, unit: "", status: statusForThreshold(lighthouseResult.cls, 0.1, 0.25), target: "≤ 0.10" });
        logs.push("Lighthouse mobile audit completed.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lighthouse could not run.";
        logs.push(`Lighthouse unavailable: ${message}`);
        pushCheck(checks, {
          id: "LIGHTHOUSE-UNAVAILABLE",
          name: "Optional Lighthouse audit",
          status: "NOT_CHECKED",
          severity: "info",
          expected: "Lighthouse runs in a supported, network-isolated local/Docker Chrome runtime.",
          actual: message,
          recommendation: "Keep ENABLE_LIGHTHOUSE=false if Chrome cannot launch. The browser timing and transfer checks above remain available.",
          pageUrl: identity.url,
        });
      }
    } else {
      pushCheck(checks, {
        id: "LIGHTHOUSE-OPTIONAL",
        name: "Lighthouse category audit",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "Lighthouse can be enabled in a supported local/Docker runtime.",
        actual: process.env.VERCEL
          ? "Lighthouse is disabled on Vercel because its separate Chrome runner does not inherit the Playwright subresource security filter."
          : process.env.ENABLE_LIGHTHOUSE === "true"
            ? "Lighthouse is enabled but the explicit LIGHTHOUSE_ALLOW_UNFILTERED_NETWORK acknowledgement is missing."
            : "Lighthouse is disabled. Browser timing and transfer checks are still active.",
        recommendation: "Only enable Lighthouse in an isolated environment where you accept that its separate Chrome process does not inherit the Playwright request filter.",
        pageUrl: identity.url,
      });
    }
    logs.push(`Browser metrics collected: ${metrics.resourceCount} resources, ${metrics.imageCount} images.`);
  } finally {
    await context.close();
  }

  const baseMetrics = metricsForChart.filter((metric) => metric.value !== null);
  const qualitySignals = baseMetrics.filter((metric) => metric.unit === "ms" || metric.unit === "").filter((metric) => metric.status !== "NOT_CHECKED");
  if (qualitySignals.length) {
    const pass = qualitySignals.filter((metric) => metric.status === "PASS").length;
    const warn = qualitySignals.filter((metric) => metric.status === "WARNING").length;
    const fail = qualitySignals.filter((metric) => metric.status === "FAIL").length;
    scores.push({ label: "Browser performance score", value: Math.round(((pass + warn * 0.5) / qualitySignals.length) * 100), detail: "Internal score based on available browser timing signals; not a Lighthouse score." });
  }

  return makeResult("performance", url, started, checks, [], {
    finalUrl,
    pageTitle,
    logs,
    metrics: metricsForChart,
    scores,
    notes: [
      "This lab measures browser navigation timing, resource transfer, JavaScript payload and image transfer. Results vary by network, cache, server load and third-party scripts.",
      "The browser-only checks are not a Lighthouse score. Optional Lighthouse mobile auditing is available in local/Docker mode with ENABLE_LIGHTHOUSE=true.",
      "INP is not claimed because this read-only run does not generate representative user interactions.",
    ],
  });
}
