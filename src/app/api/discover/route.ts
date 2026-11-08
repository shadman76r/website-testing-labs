import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, isAuthenticatedToken } from "@/lib/auth";
import { assertPublicHttpUrl } from "@/lib/security/url";
import { launchTestingBrowser } from "@/lib/browser";
import { discoverSitePages } from "@/lib/crawler";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({ url: z.string().trim().min(1).max(2048) });

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Provide a valid website URL." }, { status: 400 });

  let browser: Awaited<ReturnType<typeof launchTestingBrowser>> | undefined;
  try {
    const url = (await assertPublicHttpUrl(parsed.data.url)).toString();
    browser = await launchTestingBrowser();
    const discovery = await discoverSitePages(browser, url);
    return NextResponse.json({ data: discovery }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Page discovery failed.";
    return NextResponse.json({ error: message }, { status: /URL|hostname|resolve|private|port|HTTP|HTTPS|reserved/i.test(message) ? 400 : 500 });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
