import type { Browser } from "playwright";
import type { LabCheck, LabScore } from "@/lib/types";
import { createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

export async function runSeoGeoLab(browser: Browser, url: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const context = await createSafeContext(browser, undefined, {}, inferLocale(url));
  let finalUrl = "";
  let pageTitle = "";

  try {
    const page = await context.newPage();
    const response = await navigate(page, url);
    const identity = await pageIdentity(page);
    finalUrl = identity.url;
    pageTitle = identity.title;

    const data = await page.evaluate(async () => {
      const meta = (name: string) =>
        document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
        document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") || "";
      const title = document.title || "";
      const description = meta("description");
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
      const robots = `${meta("robots")} ${meta("googlebot")}`.trim();
      const hreflang = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((el) => ({
        lang: el.getAttribute("hreflang") || "",
        href: el.getAttribute("href") || "",
      }));
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const schemaTypes: string[] = [];
      let invalidJsonLd = 0;
      for (const script of jsonLdScripts) {
        try {
          const parsed = JSON.parse(script.textContent || "null");
          const collect = (value: any) => {
            if (!value || typeof value !== "object") return;
            if (Array.isArray(value)) return value.forEach(collect);
            const type = value["@type"];
            if (Array.isArray(type)) schemaTypes.push(...type.map(String));
            else if (type) schemaTypes.push(String(type));
            if (value["@graph"]) collect(value["@graph"]);
            if (value.mainEntity) collect(value.mainEntity);
          };
          collect(parsed);
        } catch {
          invalidJsonLd += 1;
        }
      }
      const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map((el) => (el.textContent || "").trim()).filter(Boolean);
      let robotsText = "";
      let robotsStatus = 0;
      try {
        const robotsResponse = await fetch("/robots.txt", { cache: "no-store", signal: AbortSignal.timeout(2000) });
        robotsStatus = robotsResponse.status;
        if (robotsResponse.ok) robotsText = await robotsResponse.text();
      } catch {}
      const sitemapDirectives = robotsText.split(/\r?\n/)
        .filter((line) => /^\s*sitemap\s*:/i.test(line))
        .map((line) => line.replace(/^\s*sitemap\s*:/i, "").trim())
        .filter(Boolean);
      let sitemapFound = false;
      for (const directive of sitemapDirectives.slice(0, 2)) {
        try {
          const sitemapUrl = new URL(directive, location.href);
          // Browser-side verification is limited to same-origin sitemap URLs to avoid CORS ambiguity.
          if (sitemapUrl.origin !== location.origin) continue;
          const sitemapResponse = await fetch(sitemapUrl.toString(), {
            method: "GET",
            cache: "no-store",
            signal: AbortSignal.timeout(2000),
          });
          if (sitemapResponse.ok) {
            await sitemapResponse.body?.cancel();
            sitemapFound = true;
            break;
          }
        } catch {}
      }
      if (!sitemapFound) {
        for (const candidate of ["/sitemap.xml", "/sitemap_index.xml"]) {
          try {
            const sitemapResponse = await fetch(candidate, {
              method: "GET",
              cache: "no-store",
              signal: AbortSignal.timeout(2000),
            });
            if (sitemapResponse.ok) {
              await sitemapResponse.body?.cancel();
              sitemapFound = true;
              break;
            }
          } catch {}
        }
      }
      return {
        title,
        description,
        h1Count: document.querySelectorAll("h1").length,
        htmlLang: document.documentElement.getAttribute("lang") || "",
        canonical,
        robots,
        hreflang,
        schemaTypes: Array.from(new Set(schemaTypes)),
        jsonLdCount: jsonLdScripts.length,
        invalidJsonLd,
        ogTitle: meta("og:title"),
        ogImage: meta("og:image"),
        headings,
        questionHeadingCount: headings.filter((heading) => /\?|\b(who|what|when|where|why|how)\b/i.test(heading)).length,
        robotsStatus,
        robotsText,
        sitemapDirectiveCount: sitemapDirectives.length,
        sitemapFound,
      };
    });

    const titleStatus = !data.title ? "FAIL" : data.title.length < 20 || data.title.length > 70 ? "WARNING" : "PASS";
    pushCheck(checks, {
      id: "SEO-TITLE", name: "Page title",
      status: titleStatus, severity: "high",
      expected: "A unique, descriptive title is present; approximately 20–70 characters is a practical guideline.",
      actual: data.title ? `${data.title.length} characters: ${data.title}` : "Title element is empty or missing.",
      recommendation: !data.title ? "Add a descriptive <title> element." : titleStatus === "WARNING" ? "Review title length and uniqueness; character guidance is approximate." : undefined,
      pageUrl: identity.url,
    });

    const descriptionStatus = !data.description ? "FAIL" : data.description.length < 70 || data.description.length > 170 ? "WARNING" : "PASS";
    pushCheck(checks, {
      id: "SEO-META-DESCRIPTION", name: "Meta description",
      status: descriptionStatus, severity: "medium",
      expected: "A useful meta description is present; approximately 70–170 characters is a practical guideline.",
      actual: data.description ? `${data.description.length} characters: ${data.description}` : "Meta description is missing.",
      recommendation: !data.description ? "Add a unique meta description that summarizes the page." : descriptionStatus === "WARNING" ? "Review the description length and make sure it accurately summarizes the page." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-H1", name: "H1 heading",
      status: data.h1Count === 1 ? "PASS" : data.h1Count === 0 ? "FAIL" : "WARNING",
      severity: "medium",
      expected: "One clear primary H1 heading is recommended.",
      actual: `${data.h1Count} H1 element(s) detected.`,
      recommendation: data.h1Count !== 1 ? "Review the page's primary heading structure." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-HTML-LANG", name: "HTML language attribute",
      status: data.htmlLang ? "PASS" : "FAIL", severity: "medium",
      expected: "The root HTML element declares the page language.",
      actual: data.htmlLang || "The lang attribute is missing.",
      recommendation: data.htmlLang ? undefined : 'Add an accurate lang attribute, for example lang="en" or lang="fr".',
      pageUrl: identity.url,
    });

    let canonicalStatus: "PASS" | "WARNING" | "FAIL" = "WARNING";
    let canonicalActual = "Canonical link is missing.";
    if (data.canonical) {
      try {
        const canonicalUrl = new URL(data.canonical, identity.url);
        canonicalStatus = canonicalUrl.hostname === new URL(identity.url).hostname ? "PASS" : "WARNING";
        canonicalActual = canonicalUrl.toString();
      } catch {
        canonicalStatus = "FAIL";
        canonicalActual = `Invalid canonical URL: ${data.canonical}`;
      }
    }
    pushCheck(checks, {
      id: "SEO-CANONICAL", name: "Canonical URL",
      status: canonicalStatus, severity: "medium",
      expected: "A valid canonical URL points to the preferred version of this page.",
      actual: canonicalActual,
      recommendation: canonicalStatus !== "PASS" ? "Confirm the canonical target and ensure it is intentional." : undefined,
      pageUrl: identity.url,
    });

    const xRobotsTag = response?.headers()["x-robots-tag"] || "";
    const noindex = /\bnoindex\b/i.test(data.robots) || /\bnoindex\b/i.test(xRobotsTag);
    const disallowAll = /user-agent:\s*\*\s*[\s\S]*?disallow:\s*\/\s*(?:\r?\n|$)/i.test(data.robotsText);
    pushCheck(checks, {
      id: "SEO-INDEX-DIRECTIVES", name: "Indexing directives",
      status: noindex || disallowAll ? "WARNING" : "PASS", severity: "high",
      expected: "For a page intended to appear in search, no noindex directive or site-wide Disallow: / should block crawling/indexing.",
      actual: `Meta robots: ${data.robots || "not set"} · X-Robots-Tag: ${xRobotsTag || "not set"} · robots.txt HTTP ${data.robotsStatus || "not found"} · site-wide Disallow: / ${disallowAll ? "detected" : "not detected"}.`,
      recommendation: noindex || disallowAll ? "Confirm whether this is intentional (for example, a staging site). Remove blocking directives only when the page should be public and indexable." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-SITEMAP", name: "XML sitemap discovery",
      status: data.sitemapFound ? "PASS" : "WARNING", severity: "medium",
      expected: "A sitemap is referenced in robots.txt or available at a common sitemap path.",
      actual: data.sitemapFound ? `A sitemap endpoint responded successfully (${data.sitemapDirectiveCount} robots.txt sitemap directive(s)).` : `No sitemap endpoint responded successfully (${data.sitemapDirectiveCount} robots.txt sitemap directive(s) found).`,
      recommendation: data.sitemapFound ? undefined : "Publish an XML sitemap and reference it in robots.txt.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-HREFLANG", name: "Language alternate links",
      status: data.hreflang.length ? "PASS" : "WARNING", severity: "low",
      expected: "If this page has language alternatives, hreflang links should identify them correctly.",
      actual: data.hreflang.length ? `${data.hreflang.length} hreflang alternate link(s) detected.` : "No hreflang alternate links detected. This may be expected for a single-language page.",
      recommendation: data.hreflang.length ? undefined : "For bilingual or multilingual pages, add reciprocal hreflang links where appropriate.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-OPEN-GRAPH", name: "Open Graph metadata",
      status: data.ogTitle && data.ogImage ? "PASS" : "WARNING", severity: "low",
      expected: "og:title and og:image are available for social sharing.",
      actual: `og:title ${data.ogTitle ? "present" : "missing"} · og:image ${data.ogImage ? "present" : "missing"}.`,
      recommendation: data.ogTitle && data.ogImage ? undefined : "Add appropriate Open Graph title and image metadata.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "GEO-STRUCTURED-DATA", name: "Structured data signals",
      status: data.schemaTypes.length && data.invalidJsonLd === 0 ? "PASS" : "WARNING", severity: "medium",
      expected: "Relevant JSON-LD structured data is present and parseable.",
      actual: data.schemaTypes.length
        ? `Schema types: ${data.schemaTypes.join(", ")}. ${data.invalidJsonLd} invalid JSON-LD block(s).`
        : `${data.jsonLdCount} JSON-LD block(s); no @type values were detected.`,
      recommendation: data.schemaTypes.length ? undefined : "Consider relevant Schema.org JSON-LD such as Organization, LocalBusiness, Product, Article or FAQPage. Only add schema that accurately describes visible content.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "GEO-ANSWER-STRUCTURE", name: "Answer-oriented content signals",
      status: data.questionHeadingCount > 0 ? "PASS" : "WARNING", severity: "low",
      expected: "Useful, clearly structured headings help people and answer systems understand page topics.",
      actual: `${data.questionHeadingCount} question-style heading(s) among ${data.headings.length} H1–H3 headings.`,
      recommendation: "This is a content heuristic, not a GEO ranking test. Review whether the page gives clear, factual answers to the questions visitors are likely to ask.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "SEO-PAGE-HTTP",
      name: "Page HTTP response",
      status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : "PASS",
      severity: "high",
      expected: "The page returns a successful HTTP response.",
      actual: response ? `HTTP ${response.status()}.` : "No main-document HTTP response was available.",
      pageUrl: identity.url,
    });
  } finally {
    await context.close();
  }

  const scoreFor = (items: LabCheck[]) => {
    const applicable = items.filter((item) => item.status !== "NOT_CHECKED");
    if (!applicable.length) return 0;
    const weighted = applicable.reduce((sum, item) => sum + (item.status === "PASS" ? 1 : item.status === "WARNING" ? 0.5 : 0), 0);
    return Math.round((weighted / applicable.length) * 100);
  };
  const seoItems = checks.filter((item) => item.id.startsWith("SEO-"));
  const geoItems = checks.filter((item) => item.id.startsWith("GEO-"));
  const scores: LabScore[] = [
    { label: "Technical SEO score", value: scoreFor(seoItems), detail: "Weighted score from technical SEO checks in this run." },
    { label: "GEO readiness score", value: scoreFor(geoItems), detail: "Heuristic content and structured-data score; it does not measure AI search rankings." },
  ];

  return makeResult("seo-geo", url, started, checks, [], {
    finalUrl, pageTitle, scores,
    notes: [
      "Technical SEO checks inspect the page and common robots/sitemap endpoints.",
      "Indexing directives are reported as warnings because noindex and disallow rules can be intentional on staging sites.",
      "GEO checks are transparent content/structured-data heuristics. They do not measure AI search visibility, Google indexing or ranking.",
    ],
  });
}
