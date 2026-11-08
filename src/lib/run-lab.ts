import type { Browser } from "playwright";
import type { LabId, LabResult, LabCheck, ScreenshotEvidence } from "@/lib/types";
import { launchTestingBrowser } from "@/lib/browser";
import { summarize } from "@/lib/labs/shared";
import { runResponsiveLab } from "@/lib/labs/responsive";
import { runFunctionalLab } from "@/lib/labs/functional";
import { runVisualLab } from "@/lib/labs/visual";
import { runSeoGeoLab } from "@/lib/labs/seo-geo";
import { runPerformanceLab } from "@/lib/labs/performance";
import { runAccessibilityLab } from "@/lib/labs/accessibility";
import { runRedirectLinksLab } from "@/lib/labs/redirect-links";

export interface RunLabInput {
  lab: LabId;
  url: string;
  referenceUrl?: string;
  pages: string[];
  crawlComplete?: boolean;
  crawlWarnings?: string[];
  totalDiscovered?: number;
}

function mapReferencePage(targetPageUrl: string, referenceBaseUrl: string): string {
  const targetPage = new URL(targetPageUrl);
  const referenceBase = new URL(referenceBaseUrl);
  return new URL(`${targetPage.pathname}${targetPage.search}`, referenceBase).toString();
}

async function runOnePage(browser: Browser, input: RunLabInput, pageUrl: string, index: number): Promise<LabResult> {
  switch (input.lab) {
    case "responsive": return runResponsiveLab(browser, pageUrl);
    case "functional": return runFunctionalLab(browser, pageUrl);
    case "visual": return runVisualLab(browser, pageUrl, input.referenceUrl ? mapReferencePage(pageUrl, input.referenceUrl) : undefined);
    case "seo-geo": return runSeoGeoLab(browser, pageUrl);
    case "performance": return runPerformanceLab(browser, pageUrl);
    case "accessibility": return runAccessibilityLab(browser, pageUrl);
    case "redirect-links": return runRedirectLinksLab(
      browser,
      pageUrl,
      input.referenceUrl ? mapReferencePage(pageUrl, input.referenceUrl) : undefined,
      30
    );
    default: {
      const exhaustive: never = input.lab;
      throw new Error(`Unsupported lab: ${exhaustive}`);
    }
  }
}

export async function executeLab(input: RunLabInput): Promise<LabResult> {
  const started = Date.now();
  const browser: Browser = await launchTestingBrowser();
  const checks: LabCheck[] = [];
  const screenshots: ScreenshotEvidence[] = [];
  const notes = new Set<string>();
  const logs: string[] = [`Browser started for ${input.lab}.`, `Received ${input.pages.length} page(s) in this processing batch.`];
  const metrics: NonNullable<LabResult["metrics"]> = [];
  const scores: NonNullable<LabResult["scores"]> = [];
  let firstResult: LabResult | undefined;
  let processed = 0;

  try {
    for (let index = 0; index < input.pages.length; index++) {
      const pageUrl = input.pages[index];
      logs.push(`Starting ${index + 1}/${input.pages.length}: ${pageUrl}`);
      try {
        const result = await runOnePage(browser, input, pageUrl, index);
        if (!firstResult) firstResult = result;
        checks.push(...result.checks);
        // Keep evidence payload bounded; retain detailed screenshots from the first pages in each run.
        if (index === 0 && screenshots.length < 3) screenshots.push(...result.screenshots.slice(0, 3));
        result.notes.forEach((note) => notes.add(note));
        result.metrics?.forEach((metric) => metrics.push(metric));
        result.scores?.forEach((score) => scores.push(score));
        processed += 1;
        logs.push(`Completed ${pageUrl}: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.warnings} warnings, ${result.summary.notChecked} not checked.`);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 600) : "The page test failed unexpectedly.";
        checks.push({
          id: `PAGE-RUN-${index + 1}`,
          name: `Page test execution · ${pageUrl}`,
          status: "FAIL",
          severity: "high",
          expected: "The selected lab completes its checks for this discovered page.",
          actual: message,
          recommendation: "Check whether the page is reachable, whether it requires authentication, and whether browser navigation timed out.",
          pageUrl,
        });
        logs.push(`Failed ${pageUrl}: ${message}`);
      }
    }

    if (input.crawlWarnings?.length) {
      for (const [index, warning] of input.crawlWarnings.entries()) {
        checks.push({
          id: `DISCOVERY-WARNING-${index + 1}`,
          name: "Site discovery warning",
          status: "WARNING",
          severity: "low",
          expected: "The crawler discovers all pages available through the site's sitemap and internal links.",
          actual: warning,
          recommendation: "Review sitemap coverage and manually inspect routes that are only available after authentication or JavaScript interactions.",
          pageUrl: input.url,
        });
      }
    }

    if (input.crawlComplete === false) {
      checks.push({
        id: "CRAWL-INCOMPLETE",
        name: "Website crawl completeness",
        status: "WARNING",
        severity: "high",
        expected: "All discoverable same-origin pages are included in the audit.",
        actual: `The discovery phase found ${input.totalDiscovered ?? input.pages.length} page(s), but could not confirm that the full website was enumerated.`,
        recommendation: "Use the Docker deployment for larger websites or inspect the sitemap and discovery warnings before treating this as a complete site audit.",
        pageUrl: input.url,
      });
    }

    const completed = Date.now();
    logs.push(`Batch finished. ${processed}/${input.pages.length} pages completed.`);
    const final: LabResult = {
      lab: input.lab,
      url: input.url,
      referenceUrl: input.referenceUrl,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      durationMs: completed - started,
      finalUrl: firstResult?.finalUrl || input.pages[0] || input.url,
      pageTitle: firstResult?.pageTitle,
      pagesScanned: processed,
      discoveredPages: input.pages,
      crawlComplete: input.crawlComplete,
      crawlWarnings: input.crawlWarnings || [],
      logs,
      scores: scores.length ? scores : undefined,
      metrics: metrics.length ? metrics : undefined,
      summary: summarize(checks),
      checks,
      screenshots,
      notes: Array.from(notes),
    };
    return final;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
