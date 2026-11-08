import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { LabCheck, LabResult, LabId, ScreenshotEvidence, Severity, CheckStatus } from "@/lib/types";
import { assertPublicHttpUrl } from "@/lib/security/url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

export const DEFAULT_VIEWPORT = { width: 1365, height: 900 };
export const NAVIGATION_TIMEOUT = Math.min(
  Math.max(Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS || 8000), 5000),
  15000
);

export function inferLocale(url: string): string {
  try {
    const parsed = new URL(url);
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
    if (["fr", "fr-ca", "fr-fr"].includes(firstSegment) || parsed.hostname.toLowerCase().startsWith("fr.")) return "fr-CA";
    if (["en", "en-ca", "en-us"].includes(firstSegment) || parsed.hostname.toLowerCase().startsWith("en.")) return "en-CA";
    return "en-CA";
  } catch {
    return "en-CA";
  }
}

export async function createSafeContext(
  browser: Browser,
  viewport = DEFAULT_VIEWPORT,
  device: { isMobile?: boolean; hasTouch?: boolean; deviceScaleFactor?: number } = {},
  locale = "en-CA"
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    ...device,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    locale,
  });

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (
      requestUrl.startsWith("data:") ||
      requestUrl.startsWith("blob:") ||
      requestUrl === "about:blank"
    ) {
      await route.continue();
      return;
    }
    try {
      await assertPublicHttpUrl(requestUrl);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });

  return context;
}

export async function navigate(page: Page, url: string): Promise<Response | null> {
  await assertPublicHttpUrl(url);
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  });
  await page.waitForLoadState("load", { timeout: 1500 }).catch(() => undefined);
  return response;
}

export function pushCheck(
  checks: LabCheck[],
  input: Omit<LabCheck, "severity"> & { severity?: Severity }
): void {
  checks.push({ ...input, severity: input.severity || "medium" });
}

export function summarize(checks: LabCheck[]) {
  return {
    total: checks.length,
    passed: checks.filter((item) => item.status === "PASS").length,
    failed: checks.filter((item) => item.status === "FAIL").length,
    warnings: checks.filter((item) => item.status === "WARNING").length,
    notChecked: checks.filter((item) => item.status === "NOT_CHECKED").length,
  };
}

export function makeResult(
  lab: LabId,
  url: string,
  started: number,
  checks: LabCheck[],
  screenshots: ScreenshotEvidence[],
  options: {
    referenceUrl?: string;
    finalUrl?: string;
    pageTitle?: string;
    notes?: string[];
    discoveredPages?: string[];
    logs?: string[];
    scores?: LabResult["scores"];
    metrics?: LabResult["metrics"];
    crawlComplete?: boolean;
    crawlWarnings?: string[];
  } = {}
): LabResult {
  const completed = Date.now();
  return {
    lab,
    url,
    referenceUrl: options.referenceUrl,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
    finalUrl: options.finalUrl,
    pageTitle: options.pageTitle,
    pagesScanned: options.discoveredPages?.length || 1,
    discoveredPages: options.discoveredPages || [url],
    crawlComplete: options.crawlComplete,
    crawlWarnings: options.crawlWarnings,
    logs: options.logs || [],
    scores: options.scores,
    metrics: options.metrics,
    summary: summarize(checks),
    checks,
    screenshots,
    notes: options.notes || [],
  };
}

export async function pageIdentity(page: Page) {
  return page.evaluate(() => ({
    title: document.title || "",
    url: location.href,
  }));
}

export async function screenshotData(
  page: Page,
  label: string,
  type: "jpeg" | "png" = "jpeg"
): Promise<ScreenshotEvidence> {
  const buffer = await page.screenshot({
    type,
    fullPage: false,
    ...(type === "jpeg" ? { quality: 48 } : {}),
    animations: "disabled",
  });
  return {
    label,
    dataUrl: `data:image/${type};base64,${buffer.toString("base64")}`,
  };
}

export function statusForThreshold(
  value: number,
  good: number,
  poor: number,
  lowerIsBetter = true
): CheckStatus {
  if (!Number.isFinite(value)) return "NOT_CHECKED";
  if (lowerIsBetter) return value <= good ? "PASS" : value > poor ? "FAIL" : "WARNING";
  return value >= good ? "PASS" : value < poor ? "FAIL" : "WARNING";
}


export interface StableScreenshot {
  evidence: ScreenshotEvidence | null;
  png: Buffer | null;
  meaningful: boolean;
  reason: string;
  domTextLength: number;
}

export async function waitForVisualReady(page: Page): Promise<{ textLength: number; imageCount: number; loadedImages: number; height: number }> {
  await page.waitForLoadState("networkidle", { timeout: 4500 }).catch(() => undefined);
  const stats = await page.evaluate(async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const height = Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight || 0);
    // Scroll in chunks to trigger lazy-loaded images and content before full-page capture.
    const steps = Math.min(18, Math.max(1, Math.ceil(height / Math.max(window.innerHeight, 700))));
    for (let index = 0; index < steps; index++) {
      window.scrollTo(0, Math.min(height, index * Math.max(window.innerHeight, 700)));
      await pause(90);
    }
    window.scrollTo(0, 0);
    await Promise.race([document.fonts?.ready || Promise.resolve(), pause(3500)]);
    await Promise.all(Array.from(document.images).slice(0, 100).map((image) => {
      if (image.complete) return Promise.resolve();
      return Promise.race([
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
        pause(2500),
      ]);
    }));
    await pause(500);
    const textLength = (document.body?.innerText || "").trim().length;
    return {
      textLength,
      imageCount: document.images.length,
      loadedImages: Array.from(document.images).filter((image) => image.complete && image.naturalWidth > 0).length,
      height: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight || 0),
    };
  });
  return stats;
}

export async function captureStableScreenshot(
  page: Page,
  label: string,
  options: { fullPage?: boolean; quality?: number } = {}
): Promise<StableScreenshot> {
  let stats: Awaited<ReturnType<typeof waitForVisualReady>>;
  let buffer: Buffer;
  try {
    stats = await waitForVisualReady(page);
    try {
      buffer = await page.screenshot({
        type: "png",
        fullPage: options.fullPage ?? true,
        animations: "disabled",
        timeout: 30000,
      });
    } catch (error) {
      if (options.fullPage === false) throw error;
      buffer = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", timeout: 20000 });
      stats = { ...stats, height: Math.min(stats.height, page.viewportSize()?.height || stats.height) };
    }
  } catch (error) {
    return {
      evidence: null,
      png: null,
      meaningful: false,
      reason: `Screenshot capture could not complete: ${error instanceof Error ? error.message : "unknown browser error"}`,
      domTextLength: 0,
    };
  }
  try {
    const png = PNG.sync.read(buffer);
    const stride = Math.max(1, Math.floor((png.width * png.height) / 12000));
    let sampled = 0;
    let nonWhite = 0;
    let brightnessTotal = 0;
    let brightnessSquared = 0;
    for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
      const offset = pixel * 4;
      const brightness = (png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3;
      sampled++;
      brightnessTotal += brightness;
      brightnessSquared += brightness * brightness;
      if (brightness < 247) nonWhite++;
    }
    const mean = brightnessTotal / Math.max(1, sampled);
    const variance = Math.max(0, brightnessSquared / Math.max(1, sampled) - mean * mean);
    const nonWhiteRatio = nonWhite / Math.max(1, sampled);
    const meaningful = stats.textLength > 8 || stats.loadedImages > 0 || (nonWhiteRatio > 0.015 && variance > 8);

    if (!meaningful) {
      return {
        evidence: null,
        png: null,
        meaningful: false,
        reason: `The page did not render meaningful visible content (text ${stats.textLength} chars, loaded images ${stats.loadedImages}/${stats.imageCount}, screenshot variance ${variance.toFixed(1)}).`,
        domTextLength: stats.textLength,
      };
    }

    const encoded = jpeg.encode({ data: png.data, width: png.width, height: png.height }, options.quality ?? 52);
    return {
      evidence: { label: `${label} · ${png.width}×${png.height}`, dataUrl: `data:image/jpeg;base64,${Buffer.from(encoded.data).toString("base64")}` },
      png: buffer,
      meaningful: true,
      reason: `Content ready: ${stats.textLength} text characters, ${stats.loadedImages}/${stats.imageCount} images loaded, page height ${stats.height}px.`,
      domTextLength: stats.textLength,
    };
  } catch (error) {
    return {
      evidence: null,
      png: null,
      meaningful: false,
      reason: `Screenshot analysis failed: ${error instanceof Error ? error.message : "invalid screenshot data"}`,
      domTextLength: stats.textLength,
    };
  }
}
