# Website Testing Labs v1.1

A standalone website QA workspace. It is separate from Monez QA and focuses on website discovery, browser-based testing, evidence, report history, PDF exports and test-case generation.

## Included

1. Dashboard and browser-local audit history
2. Responsive Lab
3. Functional Lab
4. Visual Testing
5. SEO & GEO scoring
6. Performance Lab with browser metrics and optional Lighthouse
7. Accessibility Lab with axe-core and severity scoring
8. Redirect & Link Lab with staging-to-live 301/308 mapping checks
9. Test Case Generator with optional OpenAI assistance
10. PDF and JSON exports

## Stack

- Next.js 15 App Router + TypeScript
- Playwright + Chromium
- axe-core
- Pixelmatch + PNGJS
- jsPDF for client-side PDF exports
- Lighthouse + Chrome Launcher (optional local/Docker mode)
- IndexedDB for browser-local report history
- Optional PostgreSQL/Neon shared report history
- Docker / Docker Compose
- Vercel-compatible Next.js API routes

PostgreSQL is optional. Browser-local IndexedDB works without a database; set `DATABASE_URL` to enable shared team history.

## Important behavior

### Reports and history
- Results stay in memory when switching between labs.
- Completed reports are saved in IndexedDB in the current browser, including screenshots.
- The dashboard shows recent reports and websites checked.
- Without `DATABASE_URL`, history is browser-local and is not shared between users, devices or browsers.
- If `DATABASE_URL` is configured, the dashboard uses a shared PostgreSQL/Neon history (last 100 reports) for the team. The `website_testing_lab_reports` table and its index are created automatically; no SQL migration needs to be run manually. Screenshots stay in the local browser to keep database storage efficient.

### Website discovery
- There is no manual page-count field.
- Discovery reads `robots.txt`, follows same-origin sitemap files and recursively visits discoverable HTML links.
- The browser UI processes the discovered URL inventory in small batches and shows progress/log entries.
- Docker defaults to up to 10,000 discovered URLs and a 10-minute discovery budget. Change `MAX_DISCOVERED_PAGES`, `MAX_SITEMAP_FILES` and `SITE_DISCOVERY_TIMEOUT_MS` in `.env` for larger sites.
- Vercel serverless discovery is constrained by the function execution window. If discovery stops early, the report is explicitly marked incomplete. Use Docker for very large site crawls.
- Orphaned pages, authenticated routes, pages requiring user interaction, and URLs absent from the sitemap and reachable HTML links cannot be guaranteed to be discovered.

### Responsive screenshots
- Tests mobile 390×844, tablet 768×1024 and desktop 1440×900.
- Waits for network settling, fonts, images and lazy-loaded content.
- Captures full-page screenshots.
- Detects likely blank screenshots and withholds them from evidence instead of showing empty white images.

### Functional checks
- Inspects buttons, forms, field labels, submit controls, search fields, dropdowns, filters and navigation links.
- Does not click controls or submit forms automatically. Real form submission may create leads, send emails or change production data. End-to-end workflows should use an approved staging account and an explicit safe-action plan.

### Visual testing
- Captures full-page target and reference screenshots after content readiness.
- Compares same-path target and live pages and calculates raw pixel difference / similarity.
- Dynamic inventory, carousels, ads, consent banners and timestamps can create legitimate pixel differences. Human review is required.

### SEO & GEO scores
- Separate scores are calculated from the technical SEO checks and GEO content/structured-data heuristics.
- Scores are internal QA signals, not a guarantee of Google indexing, search ranking or AI answer visibility.
- A staging site's `noindex` directive may be intentional.

### Performance and Lighthouse
- Browser timing and transfer metrics run by default.
- Optional Lighthouse mobile auditing is disabled by default.
- Set `ENABLE_LIGHTHOUSE=true` and `LIGHTHOUSE_ALLOW_UNFILTERED_NETWORK=true` only in an isolated local/Docker environment and only when auditing websites you own or are authorized to test. Lighthouse launches a separate Chrome process and does not inherit the Playwright subresource request filter. It is not enabled on Vercel by default. Do not enable it on a shared or untrusted deployment without adding an outbound network-isolating proxy.
- Browser-only scores are clearly labelled as internal lab scores, not Lighthouse scores.
- INP is not claimed without representative user interaction or field data.

### Accessibility
- axe-core checks tagged WCAG 2.0/2.1/2.2 A/AA and best practices.
- Severity-weighted score is an internal prioritization aid, not a WCAG conformance certificate.
- Keyboard, screen-reader and manual usability testing remain necessary.

### Redirect & Link
- Enter the staging/source URL in the main field and the live website base URL in the reference field.
- The lab checks the page redirect chain and maps internal staging links to matching paths on the live domain.
- Internal source URLs are expected to use HTTP 301 or 308 and land on the matching live path.
- External links are checked for reachability; they are not expected to redirect to the live domain.
- 401, 403 and 429 responses may be warnings because of authentication, bot protection or rate limiting.

### Test Case Generator
- Inspects visible forms, fields, buttons, links, dropdowns, search controls and page landmarks.
- Generates a rule-based test suite without an API key.
- If `OPENAI_API_KEY` is configured, it can add AI-assisted cases using `OPENAI_MODEL` (default `gpt-4.1-mini`).
- The key is used only in the server API route; it is never sent to the browser.
- French test-case generation uses the AI path; without an API key, the tool labels its rule-based English fallback clearly.
- Generated test cases are proposals, not executed results. Review business rules and expected outcomes before using them for sign-off.

## Local setup on Windows CMD

Requirements: Node.js 22+, npm.

```cmd
copy .env.example .env
notepad .env
npm install
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run build
npm run dev
```

Open `http://localhost:3000`.

Replace the sample `APP_ACCESS_PASSWORD` and `SESSION_SECRET` values before running Docker or deploying. Optionally set `DATABASE_URL` to a Neon/PostgreSQL connection string to share report history across the team. For `npm run dev` only, you may leave both blank to use the local development bypass. Docker runs with `NODE_ENV=production`, so it requires a non-empty access password and a session secret with at least 32 characters.

Generate a session secret:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### OpenAI test-case generation

Add to `.env` only if you want AI-assisted cases:

```env
OPENAI_API_KEY=your_private_key
OPENAI_MODEL=gpt-4.1-mini
```

Do not commit `.env` or share the key. Without the key, the generator still works in rule-based mode.

## Docker

Build and start:

```cmd
copy .env.example .env
notepad .env
docker compose up --build -d
```

Change the sample access password and session secret in `.env` before starting the container.

Open `http://localhost:3000`.

View logs:

```cmd
docker compose logs -f website-testing-labs
```

Stop:

```cmd
docker compose down
```

The Docker image uses the matching Playwright browser image and includes Chromium dependencies. Docker Compose increases the default page-discovery budget compared with Vercel.

To enable optional Lighthouse locally in Docker, set this in `.env`:

```env
ENABLE_LIGHTHOUSE=true
LIGHTHOUSE_ALLOW_UNFILTERED_NETWORK=true
```

Restart after changing environment variables:

```cmd
docker compose up -d --build
```

## Vercel deployment

1. Push this project folder to a new GitHub repository.
2. Import it into Vercel as a Next.js project.
3. Select Node.js 22.
4. Add `APP_ACCESS_PASSWORD` and `SESSION_SECRET` to Preview and Production environment variables.
5. Optionally add `DATABASE_URL` for shared team report history.
6. Optionally add `OPENAI_API_KEY` and `OPENAI_MODEL` for AI-assisted test-case generation.
7. Deploy.

Vercel uses `@sparticuz/chromium` for Linux serverless Playwright execution. Lighthouse is disabled on Vercel by default. Large site discovery may be incomplete because Vercel functions have execution limits; the app shows warnings rather than claiming a complete scan.

## Security

- Only public HTTP/HTTPS targets and standard web ports are accepted.
- Private, loopback, link-local and reserved IP ranges are rejected.
- Browser subresource requests are checked by the Playwright context route.
- The production app uses one shared access password. It is not a multi-user identity/role system.
- Add Vercel Deployment Protection or a proper identity provider before broad team access.
- Only scan websites you own or have explicit permission to test.
- Without `DATABASE_URL`, report history is stored only in browser IndexedDB. With `DATABASE_URL`, report checks and scores are stored in PostgreSQL/Neon; screenshot evidence remains local to the browser that captured it.

## Validation

Run after installing dependencies:

```cmd
npm run typecheck
npm run test:unit
npm run build
```

Then run a real audit against a website you own. Check the report, screenshots, page coverage, logs and Vercel function logs before using it for QA sign-off.

A successful TypeScript check does not by itself prove that a live website scan or Vercel Chromium deployment will work. Test the actual target environment before production use.
