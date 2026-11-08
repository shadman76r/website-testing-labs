import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, isAuthenticatedToken } from "@/lib/auth";
import { assertPublicHttpUrl } from "@/lib/security/url";
import { executeLab } from "@/lib/run-lab";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  lab: z.enum(["responsive", "functional", "visual", "seo-geo", "performance", "accessibility", "redirect-links"]),
  url: z.string().trim().min(1).max(2048),
  referenceUrl: z.string().trim().max(2048).optional().or(z.literal("")),
  pages: z.array(z.string().trim().min(1).max(2048)).min(1).max(5),
  crawlComplete: z.boolean().optional(),
  crawlWarnings: z.array(z.string().max(1000)).max(50).optional(),
  totalDiscovered: z.number().int().min(1).max(10000).optional(),
});

export async function POST(request: Request) {
  const cookieStore = await cookies();
  if (!isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }

  const rawBody = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request. Select a lab and provide a URL and a batch of discovered pages." }, { status: 400 });
  }

  try {
    const target = await assertPublicHttpUrl(parsed.data.url);
    const reference = parsed.data.referenceUrl ? await assertPublicHttpUrl(parsed.data.referenceUrl) : undefined;
    const pages = await Promise.all(parsed.data.pages.map(async (page) => (await assertPublicHttpUrl(page)).toString()));

    const result = await executeLab({
      lab: parsed.data.lab,
      url: target.toString(),
      referenceUrl: reference?.toString(),
      pages,
      crawlComplete: parsed.data.crawlComplete,
      crawlWarnings: parsed.data.crawlWarnings,
      totalDiscovered: parsed.data.totalDiscovered,
    });

    return NextResponse.json({ data: result }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The website test could not be completed.";
    const clientError = /URL|hostname|resolve|private|port|HTTP|HTTPS|reserved/i.test(message);
    return NextResponse.json({ error: message }, { status: clientError ? 400 : 500, headers: { "Cache-Control": "no-store" } });
  }
}
