import type { Browser } from "playwright";
import axe from "axe-core";
import type { LabCheck, LabScore } from "@/lib/types";
import { createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

export async function runAccessibilityLab(browser: Browser, url: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const scores: LabScore[] = [];
  const context = await createSafeContext(browser, undefined, {}, inferLocale(url));
  let finalUrl = "";
  let pageTitle = "";

  try {
    const page = await context.newPage();
    const response = await navigate(page, url);
    const identity = await pageIdentity(page);
    finalUrl = identity.url;
    pageTitle = identity.title;

    let result: any;
    try {
      await page.addScriptTag({ content: axe.source });
      result = await page.evaluate(async () => {
        const axeApi = (window as any).axe;
        return axeApi.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          },
        });
      });
    } catch (error) {
      pushCheck(checks, {
        id: "A11Y-AXE-UNAVAILABLE",
        name: "Automated accessibility scan",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "axe-core can be injected and complete its automated rules.",
        actual: error instanceof Error ? error.message : "The automated accessibility engine could not run.",
        recommendation: "A strict Content Security Policy or unusual page runtime may block the injected audit script. Review manually or allow an approved testing setup.",
        pageUrl: identity.url,
      });
      return makeResult("accessibility", url, started, checks, [], {
        finalUrl, pageTitle,
        notes: ["axe-core could not run on this page. Manual accessibility review is still required."],
      });
    }

    const impactCounts = {
      critical: result.violations.filter((item: any) => item.impact === "critical").length,
      serious: result.violations.filter((item: any) => item.impact === "serious").length,
      moderate: result.violations.filter((item: any) => item.impact === "moderate").length,
      minor: result.violations.filter((item: any) => item.impact === "minor").length,
    };

    const accessibilityScore = Math.max(0, Math.round(
      100
      - impactCounts.critical * 25
      - impactCounts.serious * 12
      - impactCounts.moderate * 5
      - impactCounts.minor * 2
    ));
    scores.push({
      label: "Accessibility audit score",
      value: accessibilityScore,
      detail: "Internal severity-weighted score based on axe-core findings. It is not a WCAG conformance certificate.",
    });

    pushCheck(checks, {
      id: "A11Y-AXE-SUMMARY",
      name: "Automated accessibility rules",
      status: result.violations.length === 0 ? "PASS" : (impactCounts.critical + impactCounts.serious > 0 ? "FAIL" : "WARNING"),
      severity: impactCounts.critical ? "critical" : impactCounts.serious ? "high" : "medium",
      expected: "No automated WCAG-related violations are detected by axe-core.",
      actual: `${result.violations.length} violation rule(s), ${result.passes.length} passed rule(s), ${result.incomplete.length} needs-review item(s).`,
      recommendation: result.violations.length ? "Review the individual axe findings below. Automated results should be manually confirmed before release." : undefined,
      pageUrl: identity.url,
    });

    for (const violation of result.violations.slice(0, 25)) {
      const selectors = violation.nodes.slice(0, 5).map((node: any) => node.target.join(", ")).join(" | ");
      const status = violation.impact === "critical" || violation.impact === "serious" ? "FAIL" : "WARNING";
      pushCheck(checks, {
        id: `AXE-${String(violation.id).toUpperCase()}`,
        name: violation.help,
        status,
        severity: violation.impact === "critical" ? "critical" : violation.impact === "serious" ? "high" : violation.impact === "moderate" ? "medium" : "low",
        expected: violation.description,
        actual: `${violation.nodes.length} affected node(s). Example selector(s): ${selectors || "See axe report."}`,
        recommendation: `Follow axe guidance: ${violation.helpUrl}`,
        pageUrl: identity.url,
      });
    }

    pushCheck(checks, {
      id: "A11Y-MANUAL-KEYBOARD",
      name: "Manual keyboard and screen-reader review",
      status: "NOT_CHECKED",
      severity: "info",
      expected: "Keyboard-only navigation, focus order, screen-reader announcements and meaningful interaction are verified.",
      actual: `${result.incomplete.length} axe item(s) require review. This run does not replace manual assistive-technology testing.`,
      recommendation: "Perform keyboard-only testing and a screen-reader review on critical user journeys.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "A11Y-HTTP",
      name: "Page HTTP response",
      status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : "PASS",
      severity: "high",
      expected: "Page returns a successful HTTP response.",
      actual: response ? `HTTP ${response.status()}.` : "No main-document HTTP response was available.",
      pageUrl: identity.url,
    });
  } finally {
    await context.close();
  }

  return makeResult("accessibility", url, started, checks, [], {
    finalUrl, pageTitle,
    scores,
    notes: [
      "axe-core runs automated accessibility rules tagged WCAG 2.0/2.1/2.2 A/AA and best-practice.",
      "Automated scans cannot fully verify keyboard usability, screen-reader experience, cognitive accessibility or all WCAG success criteria.",
    ],
  });
}
