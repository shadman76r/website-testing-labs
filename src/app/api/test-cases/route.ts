import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, isAuthenticatedToken } from "@/lib/auth";
import { assertPublicHttpUrl } from "@/lib/security/url";
import { launchTestingBrowser } from "@/lib/browser";
import { createSafeContext, inferLocale, navigate } from "@/lib/labs/shared";

export const runtime = "nodejs";
export const maxDuration = 120;

const schema = z.object({
  url: z.string().trim().min(1).max(2048),
  instruction: z.string().trim().max(2000).optional(),
  language: z.enum(["English", "French"]).default("English"),
});

type TestCase = {
  id: string;
  module: string;
  title: string;
  priority: "Critical" | "High" | "Medium" | "Low";
  preconditions: string;
  steps: string[];
  expected: string;
  automation: "Automatable" | "Manual review";
};

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
    const context = await createSafeContext(browser, { width: 1365, height: 900 }, {}, parsed.data.language === "French" ? "fr-CA" : inferLocale(url));
    let inventory: any;
    try {
      const page = await context.newPage();
      await navigate(page, url);
      inventory = await page.evaluate(() => {
        const labelFor = (el: Element) => {
          const input = el as HTMLInputElement;
          const aria = el.getAttribute("aria-label") || "";
          const labelledBy = el.getAttribute("aria-labelledby") || "";
          const labelled = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
          const labels = input.labels ? Array.from(input.labels).map((label) => label.textContent || "").join(" ") : "";
          return (aria || labelled || labels || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
        };
        return {
          title: document.title,
          language: document.documentElement.lang,
          forms: Array.from(document.forms).map((form, index) => ({
            index: index + 1,
            method: (form.method || "get").toUpperCase(),
            action: form.getAttribute("action") || location.href,
            fields: Array.from(form.querySelectorAll("input:not([type=hidden]),select,textarea")).map((field) => ({
              name: labelFor(field) || (field as HTMLInputElement).name || (field as HTMLInputElement).type || field.tagName.toLowerCase(),
              type: (field as HTMLInputElement).type || field.tagName.toLowerCase(),
              required: (field as HTMLInputElement).required,
              disabled: (field as HTMLInputElement).disabled,
            })),
            hasSubmit: Boolean(form.querySelector("button[type=submit],input[type=submit],button:not([type])")),
          })),
          buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")).slice(0, 60).map((button) => ({
            name: labelFor(button) || (button as HTMLInputElement).value || "Unnamed control",
            disabled: (button as HTMLButtonElement).disabled,
          })),
          links: Array.from(document.querySelectorAll("a[href]")).slice(0, 80).map((link) => ({
            name: (link.textContent || link.getAttribute("aria-label") || "").trim(),
            href: (link as HTMLAnchorElement).href,
          })),
          selects: Array.from(document.querySelectorAll("select")).map((select) => ({
            name: labelFor(select) || "Unlabelled select",
            options: select.options.length,
          })),
          searchFields: document.querySelectorAll('input[type=search],input[placeholder*="search" i],input[aria-label*="search" i]').length,
          hasHeader: Boolean(document.querySelector("header,[role=banner]")),
          hasFooter: Boolean(document.querySelector("footer,[role=contentinfo]")),
          h1Count: document.querySelectorAll("h1").length,
          images: document.images.length,
        };
      });
    } finally {
      await context.close();
    }

    const cases: TestCase[] = [];
    const add = (module: string, title: string, priority: TestCase["priority"], preconditions: string, steps: string[], expected: string, automation: TestCase["automation"] = "Automatable") => {
      cases.push({ id: `TC-${String(cases.length + 1).padStart(3, "0")}`, module, title, priority, preconditions, steps, expected, automation });
    };

    add("Page Load", "Verify website page loads successfully", "Critical", "The website is publicly accessible.", [`Open ${url}`, "Wait for the main page content to render."], "The page loads without a server error and displays meaningful content.");
    add("SEO / Structure", "Verify document title and language", "Medium", "The page is loaded.", ["Inspect the document title and HTML lang attribute."], `The page has a meaningful title and a language attribute. Current title: ${inventory.title || "missing"}; lang: ${inventory.language || "missing"}.`);
    add("Responsive", "Verify viewport configuration", "High", "The page is loaded.", ["Inspect the viewport meta tag.", "Open the page at mobile, tablet and desktop widths."], "The viewport is configured for device width and the layout has no unintended horizontal overflow.", "Manual review");
    add("Layout", "Verify header and footer presence", "Medium", "The page is loaded.", ["Inspect the header/navigation area.", "Scroll to the bottom and inspect the footer."], `Header detected: ${inventory.hasHeader ? "yes" : "no"}; footer detected: ${inventory.hasFooter ? "yes" : "no"}. Confirm both match the expected design.`, "Manual review");
    add("Content", "Verify primary heading", "Medium", "The page is loaded.", ["Inspect the page's main heading."], `Confirm one clear primary H1 is present. Detected H1 count: ${inventory.h1Count}.`);
    add("Media", "Verify page images", "Medium", "The page is loaded.", ["Inspect visible page images and thumbnails.", "Check that images are not broken or stretched."], `${inventory.images} image element(s) were detected; all required images should render correctly.`, "Manual review");

    for (const form of inventory.forms) {
      add("Forms", `Verify form ${form.index} structure and validation`, "High", `Form ${form.index} is present on the page.`, [
        `Locate form ${form.index} (${form.method} ${form.action}).`,
        ...form.fields.map((field: any) => `Inspect ${field.name} (${field.type}); required=${field.required}; disabled=${field.disabled}.`),
        "Submit with required fields empty in an approved test environment.",
        "Enter valid test data and submit using a non-production test account.",
      ], `${form.fields.length} field(s) are available; required fields show validation; successful submission produces the expected confirmation or redirect. Submit control detected: ${form.hasSubmit ? "yes" : "no"}.`, "Manual review");
    }
    if (!inventory.forms.length) add("Forms", "Verify no unexpected form is shown", "Low", "The page is loaded.", ["Inspect the page for forms expected by the approved requirements."], "The page contains only the forms specified by the product requirements.", "Manual review");

    for (const [index, button] of inventory.buttons.slice(0, 25).entries()) {
      add("Buttons", `Verify button action: ${button.name}`, "Medium", "The page is loaded and the control is visible.", [
        `Locate the control labelled "${button.name}".`,
        "Activate it in a safe test environment.",
        "Verify the resulting navigation, modal, state change or confirmation.",
      ], "The control performs the action described by its label and does not produce an error.", "Manual review");
    }
    for (const select of inventory.selects) {
      add("Filters / Dropdowns", `Verify dropdown: ${select.name}`, "Medium", "The page is loaded.", [
        `Open "${select.name}".`,
        "Verify the available options.",
        "Choose an option and inspect the resulting page state.",
      ], `${select.options} option(s) are available and the selected option updates the expected result.`, "Manual review");
    }
    if (inventory.searchFields > 0) {
      add("Search", "Verify search input and results", "High", "The page contains a search field.", [
        "Enter a valid keyword.",
        "Submit the search.",
        "Verify the matching results and empty-state behavior.",
      ], "Search returns relevant results and handles empty or invalid queries gracefully.", "Manual review");
    }
    add("Navigation", "Verify internal navigation links", "Medium", "The page is loaded.", [
      "Open each primary navigation item.",
      "Verify it leads to the correct page.",
      "Use browser back navigation and verify the previous page is restored.",
    ], `${inventory.links.length} link(s) were discovered; primary links navigate to the expected destinations.`, "Manual review");

    let generationMode = parsed.data.language === "French"
      ? "Rule-based English fallback (configure OPENAI_API_KEY for French AI generation)"
      : "Rule-based";
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You are a senior QA engineer. Produce a complete, concise, actionable website test suite from the supplied page inventory. Write all generated content in the requested language. Translate and preserve the coverage of existingCases, then add missing useful cases. Do not claim to have executed tests. Return JSON with a cases array. Each case must contain module,title,priority,preconditions,steps (array),expected,automation ('Automatable' or 'Manual review'). Do not invent business requirements or submit real forms." },
              { role: "user", content: JSON.stringify({ url, language: parsed.data.language, instruction: parsed.data.instruction || "", pageInventory: inventory, existingCases: cases }) },
            ],
            temperature: 0.2,
          }),
        });
        if (!aiResponse.ok) throw new Error(`OpenAI API returned HTTP ${aiResponse.status}.`);
        const aiJson = await aiResponse.json() as any;
        const content = aiJson.choices?.[0]?.message?.content;
        const aiCases = JSON.parse(content || "{}").cases;
        if (Array.isArray(aiCases)) {
          const improvedCases: TestCase[] = [];
          for (const item of aiCases.slice(0, 80)) {
            if (!item?.title || !Array.isArray(item.steps) || !item.expected) continue;
            improvedCases.push({
              id: `AI-${String(improvedCases.length + 1).padStart(3, "0")}`,
              module: String(item.module || "General").slice(0, 80),
              title: String(item.title).slice(0, 180),
              priority: ["Critical", "High", "Medium", "Low"].includes(item.priority) ? item.priority : "Medium",
              preconditions: String(item.preconditions || "The website is accessible.").slice(0, 500),
              steps: item.steps.slice(0, 12).map((step: unknown) => String(step).slice(0, 300)),
              expected: String(item.expected).slice(0, 800),
              automation: item.automation === "Automatable" ? "Automatable" : "Manual review",
            });
          }
          if (improvedCases.length) {
            cases.splice(0, cases.length, ...improvedCases);
            generationMode = "AI-assisted complete test suite";
          }
        }
      } catch (error) {
        generationMode = `Rule-based fallback (AI unavailable: ${error instanceof Error ? error.message : "unknown error"})`;
      }
    }

    return NextResponse.json({
      data: {
        url,
        title: inventory.title,
        generatedAt: new Date().toISOString(),
        generationMode,
        inventorySummary: {
          forms: inventory.forms.length,
          buttons: inventory.buttons.length,
          links: inventory.links.length,
          dropdowns: inventory.selects.length,
          images: inventory.images,
        },
        cases,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test case generation failed.";
    return NextResponse.json({ error: message }, { status: /URL|hostname|resolve|private|port|HTTP|HTTPS|reserved/i.test(message) ? 400 : 500 });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
