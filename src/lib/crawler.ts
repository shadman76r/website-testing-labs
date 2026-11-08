import type { Browser, BrowserContext } from "playwright";
import { assertPublicHttpUrl } from "@/lib/security/url";
import { createSafeContext, inferLocale, navigate } from "@/lib/labs/shared";

export interface DiscoveryResult {
  pages: string[];
  warnings: string[];
  complete: boolean;
  durationMs: number;
  source: "sitemap-and-links" | "links-only";
}

const MAX_PAGES = Math.min(10_000, Math.max(100, Number(process.env.MAX_DISCOVERED_PAGES || 2000)));
const MAX_SITEMAPS = Math.min(200, Math.max(10, Number(process.env.MAX_SITEMAP_FILES || 40)));
const DISCOVERY_BUDGET_MS = Math.min(600_000, Math.max(30_000, Number(process.env.SITE_DISCOVERY_TIMEOUT_MS || 85_000)));
const FILE_EXTENSION = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|mp4|mp3|mov|css|js|json|xml|woff2?|ttf|eot|xlsx?|docx?|pptx?)$/i;

function normalizedPage(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  // Query-string variants are intentionally excluded to avoid filter/search crawl traps.
  url.search = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function pageCandidate(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) return false;
    if (FILE_EXTENSION.test(url.pathname)) return false;
    if (/\/(?:logout|log-out|signout|sign-out|delete|remove|cart|checkout)(?:\/|$)/i.test(url.pathname)) return false;
    if (url.search) return false;
    return true;
  } catch {
    return false;
  }
}

async function safeGetText(context: BrowserContext, rawUrl: string): Promise<{ text: string; finalUrl: string; status: number } | null> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    try {
      await assertPublicHttpUrl(current);
    } catch {
      return null;
    }
    const response = await context.request.get(current, {
      maxRedirects: 0,
      timeout: 7000,
      headers: { "user-agent": "WebsiteTestingLabs/1.1 (+authorized QA crawler)" },
    }).catch(() => null);
    if (!response) return null;
    const status = response.status();
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers()["location"];
      await response.dispose().catch(() => undefined);
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    const contentType = response.headers()["content-type"] || "";
    const contentLength = Number(response.headers()["content-length"] || 0);
    if (!response.ok() || (contentType && !/text\/html|xml|text\/plain/i.test(contentType)) || contentLength > 5_000_000) {
      await response.dispose().catch(() => undefined);
      return null;
    }
    const text = await response.text().catch(() => "");
    await response.dispose().catch(() => undefined);
    return { text, finalUrl: current, status };
  }
  return null;
}

function extractLocs(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi))
    .map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim())
    .filter(Boolean);
}

function extractLinks(html: string, baseUrl: string, origin: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!pageCandidate(url.toString(), origin)) continue;
      const normalized = normalizedPage(url.toString());
      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch {}
  }
  return links;
}

async function discoverSitemapPages(
  context: BrowserContext,
  startUrl: string,
  origin: string,
  warnings: string[],
  started: number
): Promise<string[]> {
  const sitemapQueue: string[] = [];
  const robotsUrl = new URL("/robots.txt", startUrl).toString();
  const robots = await safeGetText(context, robotsUrl);
  if (robots?.status === 200) {
    for (const line of robots.text.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (match) {
        try {
          const sitemap = new URL(match[1], startUrl);
          if (["http:", "https:"].includes(sitemap.protocol)) sitemapQueue.push(sitemap.toString());
        } catch {}
      }
    }
  }
  sitemapQueue.push(new URL("/sitemap.xml", startUrl).toString());
  sitemapQueue.push(new URL("/sitemap_index.xml", startUrl).toString());

  const visitedSitemaps = new Set<string>();
  const pageSet = new Set<string>();
  while (sitemapQueue.length && visitedSitemaps.size < MAX_SITEMAPS && pageSet.size < MAX_PAGES) {
    if (Date.now() - started > DISCOVERY_BUDGET_MS) {
      warnings.push("Sitemap discovery stopped at the configured discovery time budget. The crawl is marked incomplete.");
      break;
    }
    const sitemapUrl = sitemapQueue.shift()!;
    if (visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);
    const sitemap = await safeGetText(context, sitemapUrl);
    if (!sitemap || sitemap.status !== 200) continue;

    const locs = extractLocs(sitemap.text);
    const isIndex = /<sitemapindex\b/i.test(sitemap.text);
    for (const loc of locs) {
      try {
        const parsed = new URL(loc);
        if (isIndex || /\.xml(?:$|\?)/i.test(parsed.pathname)) {
          if (["http:", "https:"].includes(parsed.protocol) && !visitedSitemaps.has(parsed.toString())) sitemapQueue.push(parsed.toString());
        } else if (parsed.origin === origin && pageCandidate(parsed.toString(), origin)) {
          pageSet.add(normalizedPage(parsed.toString()));
        }
      } catch {}
      if (pageSet.size >= MAX_PAGES) break;
    }
  }
  if (visitedSitemaps.size >= MAX_SITEMAPS && sitemapQueue.length) {
    warnings.push(`Sitemap file limit reached (${MAX_SITEMAPS}); additional sitemap files may remain.`);
  }
  return Array.from(pageSet);
}

export async function discoverSitePages(browser: Browser, startUrl: string): Promise<DiscoveryResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const start = await assertPublicHttpUrl(startUrl);
  const origin = start.origin;
  const context = await createSafeContext(browser, { width: 1280, height: 800 }, {}, inferLocale(startUrl));
  const pages = new Set<string>([normalizedPage(startUrl)]);
  const crawlQueue = [normalizedPage(startUrl)];
  let sitemapPages: string[] = [];
  let source: DiscoveryResult["source"] = "links-only";

  try {
    sitemapPages = await discoverSitemapPages(context, startUrl, origin, warnings, started);
    if (sitemapPages.length) {
      source = "sitemap-and-links";
      for (const item of sitemapPages) {
        if (pages.size >= MAX_PAGES) break;
        pages.add(item);
      }
    }

    // Also inspect the rendered home page so client-rendered navigation links are discovered.
    try {
      const renderedPage = await context.newPage();
      await navigate(renderedPage, startUrl);
      await renderedPage.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => undefined);
      const renderedLinks = await renderedPage.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter((href) => /^https?:\/\//i.test(href))
      );
      for (const link of renderedLinks) {
        if (pageCandidate(link, origin) && pages.size < MAX_PAGES) {
          const normalized = normalizedPage(link);
          pages.add(normalized);
          if (!crawlQueue.includes(normalized)) crawlQueue.push(normalized);
        }
      }
      await renderedPage.close();
    } catch (error) {
      warnings.push(`Rendered navigation discovery was unavailable: ${error instanceof Error ? error.message : "browser navigation failed"}`);
    }

    // Follow links reachable from the supplied start page. Sitemap entries are already in
    // the inventory and do not all need to be fetched just to be counted as discovered.
    const visited = new Set<string>();
    while (crawlQueue.length > 0) {
      if (Date.now() - started > DISCOVERY_BUDGET_MS) {
        warnings.push("Internal-link discovery reached the configured time budget. Some pages may remain undiscovered.");
        break;
      }
      const pending = crawlQueue.splice(0, 8).filter((page) => !visited.has(page));
      if (!pending.length) continue;
      pending.forEach((page) => visited.add(page));
      const responses = await Promise.all(pending.map((page) => safeGetText(context, page).catch(() => null)));
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        if (!response) {
          if (warnings.length < 50) warnings.push(`Could not read internal links from ${pending[i]}; pages linked only from that page may remain undiscovered.`);
          continue;
        }
        for (const link of extractLinks(response.text, response.finalUrl, origin)) {
          if (pages.size >= MAX_PAGES) break;
          pages.add(link);
          if (!visited.has(link) && !crawlQueue.includes(link)) crawlQueue.push(link);
        }
      }
      if (pages.size >= MAX_PAGES) break;
    }
  } finally {
    await context.close();
  }

  if (pages.size >= MAX_PAGES && warnings.length < 50) warnings.push(`Page discovery reached the safety cap of ${MAX_PAGES} URLs. The report is marked incomplete.`);
  if (!sitemapPages.length && warnings.length < 50) warnings.push("No XML sitemap URLs were found. The crawler followed reachable same-origin HTML links, but orphaned or unlinked pages cannot be guaranteed without a sitemap.");
  const complete = warnings.length === 0 && pages.size < MAX_PAGES;
  return {
    pages: Array.from(pages),
    warnings,
    complete,
    durationMs: Date.now() - started,
    source,
  };
}
