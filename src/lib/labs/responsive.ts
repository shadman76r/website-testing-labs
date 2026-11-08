import type { Browser } from "playwright";
import type { LabCheck, ScreenshotEvidence } from "@/lib/types";
import { captureStableScreenshot, createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

const VIEWPORTS = [
  { name: "Mobile", width: 390, height: 844 },
  { name: "Tablet", width: 768, height: 1024 },
  { name: "Desktop", width: 1440, height: 900 },
];

export async function runResponsiveLab(browser: Browser, url: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const screenshots: ScreenshotEvidence[] = [];
  const logs: string[] = [];
  let finalUrl = "";
  let pageTitle = "";

  for (const viewport of VIEWPORTS) {
    const device = viewport.name === "Mobile"
      ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : viewport.name === "Tablet"
        ? { hasTouch: true, deviceScaleFactor: 1.5 }
        : {};
    const context = await createSafeContext(browser, { width: viewport.width, height: viewport.height }, device, inferLocale(url));
    try {
      const page = await context.newPage();
      logs.push(`Opening ${viewport.name} viewport (${viewport.width}×${viewport.height}).`);
      const response = await navigate(page, url);
      const identity = await pageIdentity(page);
      finalUrl = identity.url;
      pageTitle = identity.title;
      const capture = await captureStableScreenshot(page, `${viewport.name} · ${viewport.width}×${viewport.height}`, { fullPage: true, quality: 42 });
      if (capture.evidence) screenshots.push(capture.evidence);
      logs.push(`${viewport.name} capture: ${capture.reason}`);
      const data = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const viewportWidth = window.innerWidth;
        const documentWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
        const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
        return {
          viewportWidth,
          documentWidth,
          overflow: Math.max(0, documentWidth - viewportWidth),
          viewportMeta,
          hasHeader: Boolean(document.querySelector("header, [role='banner']")),
          hasFooter: Boolean(document.querySelector("footer, [role='contentinfo']")),
          imageCount: document.images.length,
          brokenImages: Array.from(document.images).filter((image) => image.complete && image.naturalWidth === 0).length,
        };
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-OVERFLOW`,
        name: `${viewport.name}: horizontal overflow`,
        status: data.overflow <= 1 ? "PASS" : "FAIL",
        severity: data.overflow > 30 ? "high" : "medium",
        expected: "Document width should not exceed the viewport width.",
        actual: `${data.overflow}px horizontal overflow at ${viewport.width}px viewport width.`,
        recommendation: data.overflow > 1 ? "Inspect fixed-width sections, grids, tables, images and positioned elements at this viewport." : undefined,
        pageUrl: identity.url,
      });

      const viewportMetaValid = /width\s*=\s*device-width/i.test(data.viewportMeta);
      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-META`,
        name: `${viewport.name}: viewport meta tag`,
        status: viewportMetaValid ? "PASS" : "FAIL",
        severity: "high",
        expected: 'A viewport meta tag containing width=device-width.',
        actual: data.viewportMeta || "Viewport meta tag is missing.",
        recommendation: viewportMetaValid ? undefined : 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        pageUrl: identity.url,
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-HEADER`,
        name: `${viewport.name}: header landmark`,
        status: data.hasHeader ? "PASS" : "WARNING",
        severity: "low",
        expected: "A semantic header or banner landmark should be present.",
        actual: data.hasHeader ? "Header landmark found." : "No header/banner landmark detected; a custom non-semantic header may still exist.",
        pageUrl: identity.url,
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-IMAGES`,
        name: `${viewport.name}: image loading`,
        status: data.brokenImages > 0 ? "FAIL" : "PASS",
        severity: "medium",
        expected: "Images that have completed loading should have a natural width greater than zero.",
        actual: `${data.brokenImages} broken image(s) detected among ${data.imageCount} image element(s).`,
        recommendation: data.brokenImages > 0 ? "Check image URLs, CDN permissions, file formats and network responses." : undefined,
        pageUrl: identity.url,
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-FOOTER`,
        name: `${viewport.name}: footer landmark`,
        status: data.hasFooter ? "PASS" : "WARNING",
        severity: "low",
        expected: "A semantic footer or contentinfo landmark should be present.",
        actual: data.hasFooter ? "Footer landmark found." : "No footer/contentinfo landmark detected; a custom non-semantic footer may still exist.",
        pageUrl: identity.url,
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-HTTP`,
        name: `${viewport.name}: page response`,
        status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : "PASS",
        severity: "high",
        expected: "The page should return a successful HTTP response.",
        actual: response ? `HTTP ${response.status()}.` : "No main-document HTTP response was available.",
        pageUrl: identity.url,
      });

      pushCheck(checks, {
        id: `RESP-${viewport.name.toUpperCase()}-SCREENSHOT`,
        name: `${viewport.name}: screenshot content readiness`,
        status: capture.meaningful ? "PASS" : "WARNING",
        severity: "medium",
        expected: "The screenshot contains rendered page content after fonts and images have had time to load.",
        actual: capture.reason,
        recommendation: capture.meaningful ? undefined : "Check whether the page is blocked by a cookie wall, bot protection, JavaScript error or delayed content. Re-run after confirming the page is publicly accessible.",
        pageUrl: identity.url,
      });
      logs.push(`${viewport.name} viewport checks completed.`);
    } finally {
      await context.close();
    }
  }

  return makeResult("responsive", url, started, checks, screenshots, {
    finalUrl,
    pageTitle,
    notes: [
      "Responsive checks use mobile 390×844, tablet 768×1024 and desktop 1440×900 browser emulation.",
      "Before screenshots, the lab waits for network settling, fonts, image loading and lazy-loaded content. Empty screenshots are withheld and flagged.",
      "Full-page screenshots are evidence, not a substitute for a human visual review of every component.",
    ],
    logs,
  });
}
