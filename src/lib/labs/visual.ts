import type { Browser } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { LabCheck, ScreenshotEvidence, LabScore } from "@/lib/types";
import { captureStableScreenshot, createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

export async function runVisualLab(browser: Browser, url: string, referenceUrl?: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const screenshots: ScreenshotEvidence[] = [];
  const logs: string[] = [];
  let finalUrl = "";
  let pageTitle = "";
  let visualScore: LabScore | undefined;

  const context = await createSafeContext(browser, { width: 1440, height: 1000 }, {}, inferLocale(url));
  try {
    const targetPage = await context.newPage();
    const targetResponse = await navigate(targetPage, url);
    const targetIdentity = await pageIdentity(targetPage);
    finalUrl = targetIdentity.url;
    pageTitle = targetIdentity.title;

    const targetCapture = await captureStableScreenshot(targetPage, "Staging / target · full page", { fullPage: true, quality: 42 });
    if (targetCapture.evidence) screenshots.push(targetCapture.evidence);
    logs.push(`Target capture: ${targetCapture.reason}`);

    pushCheck(checks, {
      id: "VISUAL-TARGET-HTTP",
      name: "Target page response",
      status: !targetResponse ? "WARNING" : targetResponse.status() >= 400 ? "FAIL" : "PASS",
      severity: "high",
      expected: "Target page returns a successful HTTP response.",
      actual: targetResponse ? `HTTP ${targetResponse.status()} · ${targetIdentity.url}` : "No main-document response was captured.",
      pageUrl: targetIdentity.url,
    });

    pushCheck(checks, {
      id: "VISUAL-TARGET-RENDER",
      name: "Target screenshot readiness",
      status: targetCapture.meaningful ? "PASS" : "WARNING",
      severity: "medium",
      expected: "The target screenshot contains rendered page content after fonts and images settle.",
      actual: targetCapture.reason,
      recommendation: targetCapture.meaningful ? undefined : "Verify the URL in a normal browser and check for bot protection, delayed rendering or a JavaScript error.",
      pageUrl: targetIdentity.url,
    });

    if (!referenceUrl) {
      pushCheck(checks, {
        id: "VISUAL-BASELINE",
        name: "Reference comparison",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "A live/reference URL is supplied for comparison.",
        actual: "A target screenshot was captured, but no reference page was supplied.",
        recommendation: "Enter the corresponding live URL to compare staging against production.",
        pageUrl: targetIdentity.url,
      });
    } else if (!targetCapture.png) {
      pushCheck(checks, {
        id: "VISUAL-PIXEL-DIFF",
        name: "Screenshot comparison",
        status: "NOT_CHECKED",
        severity: "info",
        expected: "Both target and reference screenshots contain rendered content.",
        actual: "The target screenshot was withheld because it appeared blank or incomplete.",
        pageUrl: targetIdentity.url,
      });
    } else {
      const referencePage = await context.newPage();
      const referenceResponse = await navigate(referencePage, referenceUrl);
      const referenceIdentity = await pageIdentity(referencePage);
      const referenceCapture = await captureStableScreenshot(referencePage, "Live / reference · full page", { fullPage: true, quality: 42 });
      if (referenceCapture.evidence) screenshots.push(referenceCapture.evidence);
      logs.push(`Reference capture: ${referenceCapture.reason}`);

      pushCheck(checks, {
        id: "VISUAL-REFERENCE-HTTP",
        name: "Reference page response",
        status: !referenceResponse ? "WARNING" : referenceResponse.status() >= 400 ? "FAIL" : "PASS",
        severity: "medium",
        expected: "Reference page returns a successful HTTP response.",
        actual: referenceResponse ? `HTTP ${referenceResponse.status()} · ${referenceIdentity.url}` : "No main-document response was captured.",
        pageUrl: referenceIdentity.url,
      });

      if (!referenceCapture.png) {
        pushCheck(checks, {
          id: "VISUAL-REFERENCE-RENDER",
          name: "Reference screenshot readiness",
          status: "WARNING",
          severity: "medium",
          expected: "The reference screenshot contains rendered page content.",
          actual: referenceCapture.reason,
          recommendation: "Verify that the live reference page is publicly accessible and fully rendered.",
          pageUrl: referenceIdentity.url,
        });
        pushCheck(checks, {
          id: "VISUAL-PIXEL-DIFF",
          name: "Screenshot pixel comparison",
          status: "NOT_CHECKED",
          severity: "info",
          expected: "Both screenshots are available for pixel comparison.",
          actual: "The reference screenshot was withheld because it appeared blank or incomplete.",
          pageUrl: referenceIdentity.url,
        });
      } else {
        const targetPng = PNG.sync.read(targetCapture.png);
        const referencePng = PNG.sync.read(referenceCapture.png);
        const width = Math.min(targetPng.width, referencePng.width);
        const height = Math.min(targetPng.height, referencePng.height);
        const targetCrop = new Uint8Array(width * height * 4);
        const referenceCrop = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          const targetStart = y * targetPng.width * 4;
          targetCrop.set(targetPng.data.subarray(targetStart, targetStart + width * 4), y * width * 4);
          const referenceStart = y * referencePng.width * 4;
          referenceCrop.set(referencePng.data.subarray(referenceStart, referenceStart + width * 4), y * width * 4);
        }
        const diff = new Uint8Array(width * height * 4);
        const differentPixels = pixelmatch(targetCrop, referenceCrop, diff, width, height, { threshold: 0.12, includeAA: false });
        const totalPixels = Math.max(1, width * height);
        const differencePercent = (differentPixels / totalPixels) * 100;
        const similarity = Math.max(0, Math.min(100, 100 - differencePercent));
        const diffStatus = differencePercent <= 5 ? "PASS" : differencePercent <= 20 ? "WARNING" : "FAIL";
        visualScore = { label: "Visual similarity", value: Math.round(similarity), detail: `${differencePercent.toFixed(2)}% raw pixel difference; review dynamic content before treating this as a defect.` };

        pushCheck(checks, {
          id: "VISUAL-PIXEL-DIFF",
          name: "Full-page screenshot pixel difference",
          status: diffStatus,
          severity: differencePercent > 20 ? "high" : "medium",
          expected: "Target and reference pages have a low raw pixel difference at the same viewport.",
          actual: `${differencePercent.toFixed(2)}% of compared pixels differ (${differentPixels.toLocaleString()} of ${totalPixels.toLocaleString()}); compared image area ${width}×${height}.`,
          recommendation: "Review the two full-page screenshots. Cookie banners, carousels, dynamic inventory, ads, timestamps and personalized content can create expected differences.",
          pageUrl: targetIdentity.url,
        });
      }
      await referencePage.close();
    }
  } finally {
    await context.close();
  }

  const result = makeResult("visual", url, started, checks, screenshots, {
    referenceUrl,
    finalUrl,
    pageTitle,
    logs,
    scores: visualScore ? [visualScore] : undefined,
    notes: [
      "The lab captures full-page screenshots at a 1440px desktop viewport after waiting for network settling, fonts, images and lazy-loaded content.",
      "A blank or incomplete screenshot is withheld and reported instead of being presented as valid evidence.",
      "Pixel similarity is a raw image comparison, not a semantic design judgment. Dynamic regions should be reviewed by a QA engineer.",
    ],
  });
  return result;
}
