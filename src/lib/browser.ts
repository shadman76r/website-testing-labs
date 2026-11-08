import { chromium as playwrightChromium, type Browser } from "playwright";

export async function launchTestingBrowser(): Promise<Browser> {
  if (process.env.VERCEL) {
    const serverlessChromium = (await import("@sparticuz/chromium")).default;
    return playwrightChromium.launch({
      args: serverlessChromium.args,
      executablePath: await serverlessChromium.executablePath(),
      headless: true,
    });
  }

  return playwrightChromium.launch({ headless: true });
}
