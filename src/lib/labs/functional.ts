import type { Browser } from "playwright";
import type { LabCheck } from "@/lib/types";
import { createSafeContext, inferLocale, makeResult, navigate, pageIdentity, pushCheck } from "./shared";

export async function runFunctionalLab(browser: Browser, url: string) {
  const started = Date.now();
  const checks: LabCheck[] = [];
  const context = await createSafeContext(browser, undefined, {}, inferLocale(url));
  let finalUrl = "";
  let pageTitle = "";

  try {
    const page = await context.newPage();
    const response = await navigate(page, url);
    await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => undefined);
    const identity = await pageIdentity(page);
    finalUrl = identity.url;
    pageTitle = identity.title;

    const inventory = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll(
        "button, [role='button'], input[type='submit'], input[type='button']"
      ));
      const getName = (element: Element) => {
        const el = element as HTMLInputElement;
        const labelledBy = el.getAttribute("aria-labelledby");
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
          : "";
        return (
          el.getAttribute("aria-label") ||
          labelledText ||
          el.getAttribute("title") ||
          el.textContent?.trim() ||
          el.value?.trim() ||
          ""
        ).trim();
      };
      const buttons = controls.map((el) => ({
        name: getName(el),
        disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true",
      }));
      const fields = Array.from(document.querySelectorAll(
        "input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea"
      ));
      const unlabeledFields = fields.filter((field) => {
        const el = field as HTMLInputElement;
        return !(
          (el.labels && el.labels.length > 0) ||
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby") ||
          el.getAttribute("title")
        );
      });
      const forms = Array.from(document.forms).map((form) => ({
        method: (form.method || "get").toUpperCase(),
        action: form.getAttribute("action") || "(current page)",
        hasSubmit: Boolean(form.querySelector("button[type='submit'], input[type='submit'], button:not([type])")),
      }));
      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        text: (a.textContent || "").trim(),
        href: a.getAttribute("href") || "",
      }));
      const searchControls = document.querySelectorAll('input[type="search"], [role="searchbox"], input[placeholder*="search" i], input[aria-label*="search" i]').length;
      const dropdownControls = document.querySelectorAll("select, [role='combobox']").length;
      const filterControls = Array.from(document.querySelectorAll("button, a, [role='button'], label")).filter((el) => {
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
        return /filter|sort|tri(er|e|ez)?|filtre/i.test(text);
      }).length;
      const navigationLinks = document.querySelectorAll("nav a[href], [role='navigation'] a[href]").length;
      return {
        buttons,
        forms,
        fieldCount: fields.length,
        unlabeledFieldCount: unlabeledFields.length,
        linkCount: links.length,
        linksWithoutHref: links.filter((link) => !link.href.trim()).length,
        emptyNameButtons: buttons.filter((button) => !button.name).length,
        disabledButtons: buttons.filter((button) => button.disabled).length,
        searchControls,
        dropdownControls,
        filterControls,
        navigationLinks,
      };
    });

    pushCheck(checks, {
      id: "FUNC-PAGE-HTTP",
      name: "Page HTTP response",
      status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : "PASS",
      severity: "medium",
      expected: "Page returns a successful HTTP response.",
      actual: response ? `HTTP ${response.status()}.` : "No main-document HTTP response was available.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-BUTTON-NAMES", name: "Visible control accessible names",
      status: !response ? "WARNING" : response.status() >= 400 ? "FAIL" : inventory.emptyNameButtons > 0 ? "FAIL" : "PASS",
      severity: inventory.emptyNameButtons > 0 ? "high" : "medium",
      expected: "Buttons and role=button controls should have an accessible name.",
      actual: `${inventory.emptyNameButtons} unnamed control(s) among ${inventory.buttons.length} detected controls.`,
      recommendation: inventory.emptyNameButtons ? "Add visible text or an accessible aria-label to each unnamed control." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-FORM-LABELS", name: "Form field labels",
      status: inventory.unlabeledFieldCount > 0 ? "FAIL" : "PASS",
      severity: inventory.unlabeledFieldCount > 0 ? "high" : "medium",
      expected: "Input, select and textarea fields should have programmatic labels.",
      actual: `${inventory.unlabeledFieldCount} unlabeled field(s) among ${inventory.fieldCount} detected fields.`,
      recommendation: inventory.unlabeledFieldCount ? "Associate each field with a <label>, aria-label or aria-labelledby." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-FORM-SUBMIT-CONTROLS", name: "Form submit controls",
      status: inventory.forms.length === 0 ? "WARNING" : inventory.forms.some((form) => !form.hasSubmit) ? "WARNING" : "PASS",
      severity: "medium",
      expected: "Each detected form should expose a submit control.",
      actual: inventory.forms.length
        ? `${inventory.forms.filter((form) => !form.hasSubmit).length} form(s) without a detected submit control; ${inventory.forms.length} form(s) found.`
        : "No HTML forms detected on this page.",
      recommendation: "Review custom JavaScript forms manually; this structural check does not submit forms.",
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-LINK-HREF", name: "Anchor destinations",
      status: inventory.linksWithoutHref > 0 ? "WARNING" : "PASS",
      severity: "low",
      expected: "Anchors intended as links should have an href destination.",
      actual: `${inventory.linksWithoutHref} anchor(s) without href among ${inventory.linkCount} detected anchors.`,
      recommendation: inventory.linksWithoutHref ? "Use a button for actions or provide a valid href for navigation." : undefined,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-SEARCH-CONTROLS", name: "Search control discovery",
      status: inventory.searchControls > 0 ? "PASS" : "WARNING",
      severity: "low",
      expected: "Search controls are present when search is a required feature on this page.",
      actual: `${inventory.searchControls} search control(s) detected. Absence is not automatically a defect because not every page needs search.`,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-DROPDOWN-CONTROLS", name: "Dropdown control discovery",
      status: inventory.dropdownControls > 0 ? "PASS" : "WARNING",
      severity: "low",
      expected: "Dropdown controls are present when the page requires selectable options or filters.",
      actual: `${inventory.dropdownControls} select/combobox control(s) detected.`,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-FILTER-CONTROLS", name: "Filter and sort control discovery",
      status: inventory.filterControls > 0 ? "PASS" : "WARNING",
      severity: "low",
      expected: "Filter/sort controls are present where the page design requires them.",
      actual: `${inventory.filterControls} control(s) with filter/sort wording detected.`,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-NAVIGATION", name: "Navigation link discovery",
      status: inventory.navigationLinks > 0 ? "PASS" : "WARNING",
      severity: "low",
      expected: "A navigation landmark exposes links when the page has site navigation.",
      actual: `${inventory.navigationLinks} link(s) found inside nav/navigation landmarks.`,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-BUTTON-STATE", name: "Disabled controls inventory",
      status: "WARNING", severity: "info",
      expected: "Disabled states should match the intended workflow.",
      actual: `${inventory.disabledButtons} disabled control(s) found. Their intended business state cannot be inferred automatically.`,
      pageUrl: identity.url,
    });

    pushCheck(checks, {
      id: "FUNC-REAL-INTERACTIONS", name: "Real user workflows",
      status: "NOT_CHECKED", severity: "info",
      expected: "Buttons, menus, filters and forms complete their intended user journeys.",
      actual: "Not executed. This lab intentionally does not click buttons or submit forms because those actions may create leads, send messages or change production data.",
      recommendation: "Use a dedicated staging account and an approved safe-action plan before enabling workflow automation.",
      pageUrl: identity.url,
    });
  } finally {
    await context.close();
  }

  return makeResult("functional", url, started, checks, [], {
    finalUrl, pageTitle,
    notes: [
      "This lab performs a read-only structural inspection. It does not submit forms or click buttons.",
      "A PASS on markup/accessibility structure is not proof that a business workflow works end to end.",
    ],
  });
}
