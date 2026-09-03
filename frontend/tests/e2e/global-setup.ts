import { request as playwrightRequest } from "@playwright/test";

/**
 * Compile every route once, before any test runs.
 *
 * `next dev` compiles a route the first time it is requested, so the first
 * navigation to a cold route can take many seconds. The suite asserts with a
 * 15 s `expect` timeout, which made `navigation.spec.ts` ("detail pages expose
 * no more than three peer tabs") fail on a cold server and pass on a warm one
 * or in isolation — a race between the test and the bundler, not a product
 * defect. Wave 5 adds routes to the same server, so the race gets worse.
 *
 * A production build would remove the race but cannot be used here: the
 * service worker registers only when `NODE_ENV === "production"`
 * (`src/components/pwa-register.tsx:54`), and once it controls the page it
 * serves `/api/v1/*` from its own `fetch` handler, which Playwright's
 * `page.route` mocks do not intercept. Every spec in this suite drives the UI
 * from mocked reads, so the whole suite would be talking to a backend that is
 * not running.
 *
 * Warming instead keeps the dev server (and therefore the mocks) and pays the
 * compile cost once, outside any assertion's budget.
 */
const ROUTES = [
  "/login",
  "/setup",
  "/offline",
  "/today",
  "/today/recommendations",
  "/yard",
  "/yard/queue",
  "/yard/apiaries",
  "/yard/apiaries/warm",
  "/yard/apiaries/warm/flora",
  "/yard/apiaries/warm/photos",
  "/yard/apiaries/warm/labels",
  "/yard/apiaries/warm/bulk",
  "/yard/apiaries/warm/timeline",
  "/yard/hives",
  "/yard/hives/warm",
  "/yard/hives/warm/equipment",
  "/yard/hives/warm/queen",
  "/yard/hives/warm/photos",
  "/yard/queens",
  "/yard/transcribe",
  "/production",
  "/production/workbench",
  "/production/activity",
  "/production/overview",
  "/production/harvests",
  "/production/jars",
  "/production/lots",
  "/production/serials",
  "/production/products",
  "/production/varietals",
  "/production/sessions/warm",
  "/sales",
  "/sales/workbench",
  "/sales/market-day",
  "/sales/consignment",
  "/sales/consignment/warm",
  "/sales/customers",
  "/sales/expenses",
  "/sales/warm",
  "/equipment",
  "/equipment/types",
  "/insights",
  "/insights/outcomes",
  "/insights/survival",
  "/insights/yield",
  "/insights/finance",
  "/insights/economics",
  "/insights/profitability",
  "/insights/sales-planning",
  "/insights/bottling",
  "/insights/compliance",
  "/insights/reconciliation",
  "/admin",
  "/admin/setup",
  "/me",
  "/honey/warm",
  "/sw.js",
  "/manifest.webmanifest",
];

export default async function globalSetup() {
  const context = await playwrightRequest.newContext({
    baseURL: "http://localhost:3010",
  });
  for (const route of ROUTES) {
    try {
      // Status is irrelevant — most of these render an error state without a
      // backend. Requesting them is what compiles them.
      await context.get(route, { timeout: 120_000 });
    } catch {
      // A route that will not compile fails its own spec with a real message;
      // warming must never be the thing that fails the run.
    }
  }
  await context.dispose();
}
