import { expect, test } from "@playwright/test";

/**
 * The route reset deleted these paths outright — no redirects, no preserved
 * aliases (roadmap P1 item 10; `docs/plans/2026-09-03-route-rename-map.md`).
 * The app is not live to the public and no QR label has ever been printed, so
 * there is nothing to be compatible with. If any of these resolves again, an
 * alias has crept back in.
 *
 * This is the one file under `frontend/` allowed to name retired paths; the
 * rename map's §4 searches treat a hit anywhere else as a miss in wave 5.
 *
 * Every check here is a plain HTTP GET rather than a browser navigation. It
 * is what the assertions actually need — a status, or the server-rendered
 * markup — and forty-odd extra page loads on a shared dev server is enough
 * contention to time out the specs running beside it.
 */

/**
 * The story route's own shells — the story, its `not-found.tsx` and its
 * `error.tsx` — all carry this eyebrow. Next's default 404 page does not, so
 * it distinguishes "the route is still mounted" from "the route is gone"
 * without needing a backend to answer.
 */
const STORY_EYEBROW = "From hive to jar";

/** Paths the router must not know about at all. */
const RETIRED = [
  // Today
  "/dashboard",
  "/recommendations",
  // Yard
  "/operations/yard-queue",
  "/apiaries",
  "/apiaries/retired",
  "/apiaries/retired/flora",
  "/apiaries/retired/photos",
  "/apiaries/retired/labels",
  "/apiaries/retired/bulk",
  "/apiaries/retired/timeline",
  "/hives",
  "/hives/retired",
  "/hives/retired/equipment",
  "/hives/retired/queen",
  "/hives/retired/photos",
  "/hives/retired/transcribe",
  "/queens",
  "/genealogy",
  "/transcribe",
  // Production — the twelve /harvest/* shims …
  "/harvest",
  "/harvest/activity",
  "/harvest/harvests",
  "/harvest/jars",
  "/harvest/lots",
  "/harvest/market-day",
  "/harvest/production",
  "/harvest/products",
  "/harvest/sales",
  "/harvest/serials",
  "/harvest/sales/00000000-0000-0000-0000-000000000000",
  "/harvest/sessions/00000000-0000-0000-0000-000000000000",
  // … and the two-segment /honey pages, past the public story's single slug.
  "/honey",
  "/honey/sales/00000000-0000-0000-0000-000000000000",
  "/honey/sessions/00000000-0000-0000-0000-000000000000",
  // Equipment
  "/inventory",
  "/inventory/types",
  // Insights
  "/reports",
  "/reports/outcomes",
  "/reports/survival",
  "/reports/yield",
  "/reports/finance",
  "/reports/economics",
  "/reports/profitability",
  "/reports/expenses",
  "/reports/sales-planning",
  "/reports/bottling",
  "/reports/customers",
  // Admin
  "/settings",
];

test("every retired path is gone, and none of them redirects", async ({
  request,
}) => {
  // maxRedirects: 0 is as much the point of this test as the 404 is. A
  // compatibility redirect would otherwise be followed and answer 200.
  const statuses = await Promise.all(
    RETIRED.map(async (path) => ({
      path,
      status: (await request.get(path, { maxRedirects: 0 })).status(),
    })),
  );
  const resolved = statuses
    .filter((entry) => entry.status !== 404)
    .map((entry) => `${entry.path} -> ${entry.status}`);
  expect(resolved, "these retired paths still resolve").toEqual([]);
});

/**
 * The single-segment `/honey/*` pages are retired differently, and it is the
 * only way they can be.
 *
 * `/honey/[slug]` is frozen (it is printed on jar QR codes) and it is a
 * dynamic segment, so `/honey/activity` cannot answer 404 — it is a slug now.
 * What must be true is that it is no longer an *authenticated app page*: it
 * resolves inside the public story namespace, with the story chrome and no
 * app shell. That is the whole point of the evacuation, and it is what let
 * `commerceSlugReserved` be deleted.
 */
const HONEY_EVACUATED = [
  "/honey/activity",
  "/honey/harvests",
  "/honey/jars",
  "/honey/lots",
  "/honey/market-day",
  "/honey/production",
  "/honey/products",
  "/honey/sales",
  "/honey/serials",
  "/honey/varietals",
];

test("the old honey pages are public story slugs, not app pages", async ({
  request,
}) => {
  const pages = await Promise.all(
    HONEY_EVACUATED.map(async (path) => ({
      path,
      html: await (await request.get(path)).text(),
    })),
  );
  const wrong: string[] = [];
  for (const { path, html } of pages) {
    if (!html.includes(STORY_EYEBROW)) {
      wrong.push(`${path}: not the story route`);
    }
    if (html.includes('aria-label="Main navigation"')) {
      wrong.push(`${path}: still renders the app shell`);
    }
  }
  expect(wrong).toEqual([]);
});

/** The one external URL contract. */
test("the public honey story is still reachable", async ({ request }) => {
  const html = await (await request.get("/honey/summer-clover-2026")).text();
  expect(html).toContain(STORY_EYEBROW);
});

/**
 * `/honey/varietals` was the latent bug the evacuation fixes by construction
 * (design 2026-09-03 D7): the reserved-slug guard omitted `varietals`, so a
 * lot slugged that way was silently shadowed by the authenticated varietals
 * page and its story was unreachable. There is no authenticated route under
 * `/honey` left to shadow it, which is why the guard could be deleted.
 */
test("a lot slugged like an old honey route reaches the public story", async ({
  request,
}) => {
  const html = await (await request.get("/honey/varietals")).text();
  expect(html).toContain(STORY_EYEBROW);
});
