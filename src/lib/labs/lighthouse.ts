import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { chromium } from "playwright";

export interface LighthouseCategory {
  id: "performance" | "accessibility" | "best-practices" | "seo";
  title: string;
  score: number;
  displayValue?: string;
}

export async function runLighthouseAudit(url: string): Promise<{ categories: LighthouseCategory[]; lcpMs?: number; cls?: number; tbtMs?: number }> {
  let chromePath = chromium.executablePath();
  let chromeFlags = ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

  if (process.env.VERCEL) {
    const serverlessChromium = (await import("@sparticuz/chromium")).default;
    chromePath = await serverlessChromium.executablePath();
    chromeFlags = [...serverlessChromium.args, "--disable-gpu"];
  }

  const chrome = await chromeLauncher.launch({
    chromePath,
    chromeFlags,
    logLevel: "error",
  });

  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      formFactor: "mobile",
      screenEmulation: {
        mobile: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        disabled: false,
      },
    } as never);

    if (!result?.lhr) throw new Error("Lighthouse did not return a report.");
    const lhr = result.lhr;
    const ids = ["performance", "accessibility", "best-practices", "seo"] as const;
    const categories = ids.flatMap((id) => {
      const category = lhr.categories[id];
      return typeof category?.score === "number"
        ? [{ id, title: category.title, score: Math.round(category.score * 100) }]
        : [];
    });
    const audits = lhr.audits;
    const numeric = (id: string) => {
      const value = audits[id]?.numericValue;
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    return {
      categories,
      lcpMs: numeric("largest-contentful-paint"),
      cls: numeric("cumulative-layout-shift"),
      tbtMs: numeric("total-blocking-time"),
    };
  } finally {
    // await chrome.kill().catch(() => undefined);
    try {
  chrome.kill();
} catch {
  // Ignore cleanup errors if Chrome has already exited.
}
  }
}
