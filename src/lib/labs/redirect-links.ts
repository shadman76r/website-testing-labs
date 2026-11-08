import type { Browser, APIResponse } from "playwright";
import type { LabCheck, ScreenshotEvidence, LabScore } from "@/lib/types";
import { assertPublicHttpUrl, normalizeUrlForComparison } from "@/lib/security/url";
import { captureStableScreenshot, createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

async function requestOneLink(context: Awaited<ReturnType<typeof createSafeContext>>, rawUrl: string) {
  let current = rawUrl;
  const chain: Array<{ url: string; status: number }> = [];

  for (let hop = 0; hop < 5; hop++) {
    let response: APIResponse;
    try {
      await assertPublicHttpUrl(current);
      response = await context.request.head(current, { maxRedirects: 0, timeout: 6000 });
      if ([403, 405, 501].includes(response.status())) {
        await response.dispose().catch(() => undefined);
        response = await context.request.get(current, {
          maxRedirects: 0,
          timeout: 6000,
          headers: { range: "bytes=0-0" },
        });
      }
    } catch (error) {
      return { url: rawUrl, status: 0, error: error instanceof Error ? error.message : "Network request failed.", chain };
    }

    const status = response.status();
    chain.push({ url: current, status });
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers()["location"];
      if (!location) {
        await response.dispose().catch(() => undefined);
        return { url: rawUrl, status, error: "Redirect response did not include a Location header.", chain };
      }
      await response.dispose().catch(() => undefined);
      try {
        current = new URL(location, current).toString();
      } catch {
        return { url: rawUrl, status, error: "Redirect response contained an invalid Location URL.", chain };
      }
      continue;
    }
    await response.dispose().catch(() => undefined);
    return { url: rawUrl, status, finalUrl: current, chain };
  }

  return { url: rawUrl, status: 310, error: "Redirect limit exceeded (5 hops).", chain };
}

function statusForLink(status: number) {
  if (status >= 200 && status < 400) return "PASS" as const;
  if (status === 401 || status === 403 || status === 429) return "WARNING" as const;
  return "FAIL" as const;
}

export async function runRedirectLinksLab(browser: Browser, url: string, expectedDestination?: string, maxLinks = 30) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const screenshots: ScreenshotEvidence[] = [];
  const scores: LabScore[] = [];
  const logs: string[] = [];
  const context = await createSafeContext(browser, undefined, {}, inferLocale(url));
  let finalUrl = "";
  let pageTitle = "";

  try {
    const page = await context.newPage();
    const response = await navigate(page, url);
    const identity = await pageIdentity(page);
    finalUrl = identity.url;
    pageTitle = identity.title;

    const chain: Array<{ url: string; status: number }> = [];
    if (response) {
      let request: import("playwright").Request | null = response.request();
      while (request) {
        const requestResponse = await request.response().catch(() => null);
        if (requestResponse) chain.unshift({ url: request.url(), status: requestResponse.status() });
        request = request.redirectedFrom();
      }
    }

    const finalStatus = response?.status() ?? 0;
    pushCheck(checks, {
      id: "REDIRECT-INITIAL-RESPONSE",
      name: "Target URL HTTP response",
      status: finalStatus >= 200 && finalStatus < 400 ? "PASS" : finalStatus === 401 || finalStatus === 403 ? "WARNING" : "FAIL",
      severity: "high",
      expected: "The target URL resolves to a usable page with a successful final HTTP response.",
      actual: `Final response: HTTP ${finalStatus || "unavailable"} · Final URL: ${identity.url}.`,
      pageUrl: identity.url,
    });

    const redirectCount = Math.max(0, chain.length - 1);
    pushCheck(checks, {
      id: "REDIRECT-CHAIN",
      name: "Redirect chain",
      status: redirectCount <= 1 ? "PASS" : "WARNING",
      severity: "medium",
      expected: "A URL should resolve directly or through at most one intentional redirect.",
      actual: redirectCount
        ? `${redirectCount} redirect hop(s): ${chain.map((item) => `${item.status} ${item.url}`).join(" → ")}`
        : "No HTTP redirect was observed for the supplied URL.",
      recommendation: redirectCount > 1 ? "Update old redirect rules to point directly to the final destination and avoid unnecessary hops." : undefined,
      pageUrl: identity.url,
    });

    if (redirectCount > 0) {
      const firstRedirect = chain.find((item) => [301, 302, 303, 307, 308].includes(item.status));
      const permanent = firstRedirect?.status === 301 || firstRedirect?.status === 308;
      pushCheck(checks, {
        id: "REDIRECT-TYPE",
        name: "Redirect type",
        status: permanent ? "PASS" : "WARNING",
        severity: "medium",
        expected: "Use HTTP 301 for a permanent URL move (308 is also permanent but less commonly used).",
        actual: firstRedirect ? `First observed redirect status: HTTP ${firstRedirect.status}.` : "No redirect response was captured.",
        recommendation: permanent ? undefined : "If this is a permanent URL migration, confirm whether a 301 redirect is required instead of a temporary redirect.",
        pageUrl: identity.url,
      });
    } else {
      pushCheck(checks, {
        id: "REDIRECT-TYPE",
        name: "Redirect type",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "A 301 response is present when a permanent redirect is expected.",
        actual: "No redirect was observed, so a redirect type could not be evaluated.",
        pageUrl: identity.url,
      });
    }

    if (expectedDestination) {
      const matches = normalizeUrlForComparison(identity.url) === normalizeUrlForComparison(expectedDestination);
      pushCheck(checks, {
        id: "REDIRECT-EXPECTED-DESTINATION",
        name: "Expected redirect destination",
        status: matches ? "PASS" : "FAIL",
        severity: "high",
        expected: normalizeUrlForComparison(expectedDestination),
        actual: normalizeUrlForComparison(identity.url),
        recommendation: matches ? undefined : "Update the redirect mapping so the source URL lands on the expected destination.",
        pageUrl: identity.url,
      });
    } else {
      pushCheck(checks, {
        id: "REDIRECT-EXPECTED-DESTINATION",
        name: "Expected redirect destination",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "An expected destination URL is supplied for an explicit source-to-destination assertion.",
        actual: "No expected destination URL was provided. The observed redirect chain is still reported.",
        recommendation: "Enter the intended destination URL when validating a specific 301 mapping.",
        pageUrl: identity.url,
      });
    }

    const allLinks = await page.evaluate(() => {
      const seen = new Set<string>();
      const output: string[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (anchor as HTMLAnchorElement).href;
        if (!/^https?:\/\//i.test(href)) continue;
        const normalized = href.split("#")[0];
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
      }
      return output.slice(0, 2000);
    });
    const maxToCheck = Math.min(Math.max(maxLinks, 1), 30);
    const stagingOrigin = new URL(identity.url).origin;
    const internalCandidates = allLinks.filter((link) => {
      try { return new URL(link).origin === stagingOrigin; } catch { return false; }
    });
    const externalCandidates = allLinks.filter((link) => {
      try { return new URL(link).origin !== stagingOrigin; } catch { return false; }
    });
    // Prioritize internal links because they are the URLs relevant to staging-to-live redirect mapping.
    const links = [
      ...internalCandidates.slice(0, maxToCheck),
      ...externalCandidates.slice(0, Math.max(0, maxToCheck - Math.min(internalCandidates.length, maxToCheck))),
    ];

    const results: Array<{ url: string; status: number; error?: string; finalUrl?: string; chain: Array<{url:string;status:number}> }> = [];
    for (let offset = 0; offset < links.length; offset += 4) {
      const group = links.slice(offset, offset + 4);
      const groupResults = await Promise.all(group.map((link) => requestOneLink(context, link)));
      results.push(...groupResults);
    }

    const broken = results.filter((item) => statusForLink(item.status) === "FAIL" || item.error);
    const blocked = results.filter((item) => statusForLink(item.status) === "WARNING");
    pushCheck(checks, {
      id: "LINK-SAMPLE-SUMMARY",
      name: "Discovered link health",
      status: broken.length ? "FAIL" : blocked.length ? "WARNING" : "PASS",
      severity: broken.length ? "high" : "medium",
      expected: "Sampled links return successful HTTP responses.",
      actual: `${results.length} unique link(s) checked (maximum ${Math.min(Math.max(maxLinks, 1), 30)} for this page): ${results.length - broken.length - blocked.length} successful, ${broken.length} failed, ${blocked.length} blocked/rate-limited.`,
      recommendation: broken.length ? "Review failed destinations and update or remove broken links. Recheck transient network errors manually." : blocked.length ? "Some destinations blocked automated checks; verify those links in a normal browser." : undefined,
      pageUrl: identity.url,
    });

    for (const item of broken.slice(0, 15)) {
      pushCheck(checks, {
        id: `LINK-${Buffer.from(item.url).toString("base64url").slice(0, 16)}`,
        name: "Broken or unreachable link",
        status: "FAIL",
        severity: "medium",
        expected: "Link destination returns a successful HTTP response.",
        actual: `${item.url} · HTTP ${item.status || "network error"}${item.error ? ` · ${item.error}` : ""}`,
        recommendation: "Verify the destination, fix the link or remove it if the content no longer exists.",
        pageUrl: identity.url,
      });
    }

    for (const item of blocked.slice(0, 8)) {
      pushCheck(checks, {
        id: `LINK-BLOCKED-${Buffer.from(item.url).toString("base64url").slice(0, 12)}`,
        name: "Link could not be verified automatically",
        status: "WARNING",
        severity: "low",
        expected: "Link destination allows an automated status check.",
        actual: `${item.url} · HTTP ${item.status}.`,
        recommendation: "Open this destination manually; authentication, bot protection or rate limiting may block automated checks.",
        pageUrl: identity.url,
      });
    }

    if (expectedDestination) {
      const liveBase = new URL(expectedDestination);
      const internalLinks = allLinks.filter((link) => {
        try { return new URL(link).origin === stagingOrigin; } catch { return false; }
      });
      const mappingResults = results.filter((item) => {
        try { return new URL(item.url).origin === stagingOrigin; } catch { return false; }
      });
      let matched = 0;
      let mismatched = 0;
      let uncertain = 0;
      for (const item of mappingResults) {
        const source = new URL(item.url);
        const expectedLive = new URL(`${source.pathname}${source.search}`, liveBase);
        const actualFinal = item.finalUrl ? normalizeUrlForComparison(item.finalUrl) : "";
        const expectedFinal = normalizeUrlForComparison(expectedLive.toString());
        const permanentHop = item.chain.some((hop) => hop.status === 301 || hop.status === 308);
        const temporaryHop = item.chain.some((hop) => hop.status === 302 || hop.status === 303 || hop.status === 307);
        if (item.error || item.status === 0 || item.status === 401 || item.status === 403 || item.status === 429) {
          uncertain++;
          continue;
        }
        if (permanentHop && actualFinal === expectedFinal) {
          matched++;
        } else {
          mismatched++;
          if (mismatched <= 20) {
            pushCheck(checks, {
              id: `REDIRECT-MAP-${Buffer.from(item.url).toString("base64url").slice(0, 14)}`,
              name: "Staging-to-live redirect mapping mismatch",
              status: "FAIL",
              severity: "high",
              expected: `HTTP 301/308 redirect to ${expectedFinal}`,
              actual: `${temporaryHop ? "Temporary redirect" : permanentHop ? "Permanent redirect to a different URL" : "No permanent redirect detected"} · final ${actualFinal || "unavailable"}`,
              recommendation: "Add or correct the permanent redirect so the staging/source path lands on the matching live URL.",
              pageUrl: item.url,
            });
          }
        }
      }
      pushCheck(checks, {
        id: "REDIRECT-MAP-SUMMARY",
        name: "Staging-to-live internal URL mapping",
        status: internalLinks.length === 0 ? "WARNING" : mismatched > 0 ? "FAIL" : uncertain > 0 ? "WARNING" : "PASS",
        severity: mismatched > 0 ? "high" : "medium",
        expected: "Every checked internal staging URL redirects permanently (301/308) to the corresponding path on the supplied live domain.",
        actual: `${matched} correct permanent mapping(s), ${mismatched} mismatch(es), ${uncertain} URL(s) could not be verified. ${internalLinks.length} internal link(s) were discovered; up to ${maxToCheck} internal links were sampled on this page.`,
        recommendation: mismatched > 0 ? "Review each mismatch and update the redirect map. A temporary 302/307 does not satisfy a permanent 301 requirement." : uncertain > 0 ? "Manually verify blocked or rate-limited URLs." : undefined,
        pageUrl: identity.url,
      });
      logs.push(`Compared ${mappingResults.length} internal staging link(s) against the live domain: ${matched} match, ${mismatched} mismatch, ${uncertain} unverified.`);
      const total = matched + mismatched;
      if (total > 0) scores.push({ label: "301 mapping accuracy", value: Math.round((matched / total) * 100), detail: `${matched} correct permanent mappings from ${total} verifiable internal URLs.` });
    } else {
      pushCheck(checks, {
        id: "REDIRECT-MAP-SUMMARY",
        name: "Staging-to-live mapping comparison",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "A live website base URL is supplied to verify staging URL 301 mappings.",
        actual: "No live reference URL was supplied. Link health and observed redirect chains were still checked.",
        recommendation: "Enter the live website URL to compare every discovered internal staging URL against its corresponding live path.",
        pageUrl: identity.url,
      });
    }

    const capture = await captureStableScreenshot(page, "Staging page · full page", { fullPage: true, quality: 42 });
    if (capture.evidence) screenshots.push(capture.evidence);
    logs.push(`Staging screenshot: ${capture.reason}`);
  } finally {
    await context.close();
  }

  return makeResult("redirect-links", url, started, checks, screenshots, {
    referenceUrl: expectedDestination,
    finalUrl, pageTitle,
    scores,
    logs,
    notes: [
      "The link checker prioritizes internal links for redirect mapping, then uses any remaining sample slots for external link health. Up to 30 unique links are checked per page.",
      "When a live reference URL is supplied, internal staging links are compared with the same path on the live domain and must use a permanent 301/308 redirect.",
      "This redirect comparison is intended for authorized staging-to-live migration checks. External links are checked for reachability, not expected to redirect to the live domain.",
      "401, 403 and 429 responses are warnings because authentication, bot protection and rate limits can block automated verification.",
      "The supplied URL's navigation redirect chain is captured from the browser response.",
    ],
  });
}
