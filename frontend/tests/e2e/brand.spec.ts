import { expect, test, type Page } from "@playwright/test";

import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_TAGLINE,
  DEFAULT_THEME_COLOR,
} from "../../src/lib/brand";

/**
 * The two-brand matrix for the runtime brand contract (roadmap P1 item 11).
 *
 * One suite cannot run two dev servers, and the brand is resolved once per
 * server process from `BRAND_*`, so the matrix is split deliberately:
 *
 *  - *this* file drives the running server, which has no `BRAND_*` set, and
 *    pins the unconfigured product default end to end — SSR metadata, the
 *    manifest, the shell wordmark, install copy, the public Honey Story, and
 *    the offline fallback all say "Apiary Atlas";
 *  - `tests/unit/brand.test.mjs` drives the same `parseBrand` the server calls
 *    with the GentleBee production environment and with a third, unrelated
 *    test brand, and pins the fallbacks and the rejection of invalid values.
 *
 * Together they cover the acceptance criterion: one unchanged build serves the
 * default brand, an overridden brand, and a third brand, with no source edit.
 *
 * Every read here is `page.route`-mocked, like the rest of this suite; the
 * backend is not running.
 */

/** What an unconfigured deployment must call itself, everywhere. */
const PRODUCT = "Apiary Atlas";

/** The name this app must no longer show a user anywhere. */
const LEGACY_NAME = "Beez Trackz";

async function mockAuthenticated(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Brand test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-admin",
          displayName: "Brand test",
          email: null,
          isAdmin: true,
          hasPassword: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/me/preferences")) {
      return route.fulfill({
        json: {
          theme: "system",
          defaultApiaryId: null,
          dateFormat: "MM/DD/YYYY",
          weightUnit: "oz",
          units: "us",
          temperatureUnit: null,
        },
      });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: null } });
    }
    if (path.endsWith("/ops/labor/current")) {
      return route.fulfill({ json: { enabled: false, current: null } });
    }
    // Same default as settings-split.spec.ts: the remaining reads on this page
    // are collections.
    return route.fulfill({ json: [] });
  });
}

test("server-rendered document metadata carries the default brand", async ({
  page,
}) => {
  await page.goto("/login");

  // The root metadata `title.default`.
  await expect(page).toHaveTitle(PRODUCT);

  const description = page.locator('meta[name="description"]');
  await expect(description).toHaveAttribute("content", DEFAULT_TAGLINE);

  // applicationName and the Apple home-screen title. The Apple title uses the
  // short name, which for "Apiary Atlas" (12 characters) is the whole name.
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
    "content",
    PRODUCT,
  );
  await expect(
    page.locator('meta[name="apple-mobile-web-app-title"]'),
  ).toHaveAttribute("content", PRODUCT);

  // Light-mode chrome is brand-tinted; dark is the fixed app constant, so a
  // configured color can never wreck the status-bar contrast.
  await expect(
    page.locator('meta[name="theme-color"][media*="light"]'),
  ).toHaveAttribute("content", DEFAULT_THEME_COLOR);
  await expect(
    page.locator('meta[name="theme-color"][media*="dark"]'),
  ).toHaveAttribute("content", "#1c1917");
});

// NOTE: the `%s · <brand>` title template is not asserted here. The only route
// that sets its own title is the Honey Story, and with no backend running its
// `generateMetadata` throws before producing one. The template's brand half is
// the same `resolveBrand()` value the default title above already pins; the
// composed form needs a full-stack run to observe.

test("the web manifest is generated from the resolved brand", async ({
  request,
}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();

  expect(manifest.name).toBe(PRODUCT);
  expect(manifest.short_name).toBe(PRODUCT);
  expect(manifest.description).toBe(DEFAULT_TAGLINE);
  expect(manifest.theme_color).toBe(DEFAULT_THEME_COLOR);
  expect(manifest.background_color).toBe(DEFAULT_BACKGROUND_COLOR);

  // With no BRAND_MARK_URL the bundled Apiary Atlas icon set is used
  // unchanged, maskable pair included.
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-192.png",
    "/icons/icon-maskable-512.png",
  ]);

  // Machine identity: the launch and shortcut routes are a contract, not
  // branding, and must not move when the name does.
  expect(manifest.start_url).toBe("/today");
  expect(manifest.scope).toBe("/");
  expect(
    manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url),
  ).toEqual(["/yard/apiaries", "/yard/hives", "/production"]);

  expect(JSON.stringify(manifest)).not.toContain(LEGACY_NAME);
});

test("the sign-in wordmark and the setup welcome use the brand", async ({
  page,
}) => {
  await page.goto("/login");
  // The auth shell's lockup: built-in mark plus the display name as text.
  await expect(page.getByText(PRODUCT).first()).toBeVisible();
  expect(await page.content()).not.toContain(LEGACY_NAME);

  await page.goto("/setup");
  await expect(page.getByText(`Welcome to ${PRODUCT}`)).toBeVisible();
  expect(await page.content()).not.toContain(LEGACY_NAME);
});

test("the offline fallback names the brand and keeps its mark labelled", async ({
  page,
}) => {
  await page.goto("/offline");
  // The mark is the only product identity on this page, so it carries the
  // brand name as its accessible label rather than being decorative.
  await expect(page.getByRole("img", { name: PRODUCT })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  expect(await page.content()).not.toContain(LEGACY_NAME);
});

test("My preferences describes the install as the deployment brand", async ({
  page,
}) => {
  await mockAuthenticated(page);
  await page.goto("/me");
  await expect(
    page.getByText(`Add ${PRODUCT} to your home screen.`),
  ).toBeVisible();
  expect(await page.content()).not.toContain(LEGACY_NAME);
});

test("the public Honey Story is branded without moving its route", async ({
  page,
}) => {
  // The API is not running for this suite, so an unknown slug lands on either
  // the story's not-found or its error boundary. Both are public, app-owned
  // recovery surfaces and both must carry the brand — asserting the link they
  // share covers whichever one renders.
  await page.goto("/honey/brand-spec-no-such-lot");

  // The route itself is a public contract: an old QR code must still resolve
  // here, so branding may not turn this into a redirect. (The HTTP status is
  // not asserted — with the API down the story fetch fails, which is a 500
  // about the missing backend, not about the brand.)
  expect(new URL(page.url()).pathname).toBe("/honey/brand-spec-no-such-lot");

  await expect(
    page.getByRole("link", { name: `Back to ${PRODUCT}` }),
  ).toBeVisible();
  expect(await page.content()).not.toContain(LEGACY_NAME);
});

test("the service worker keeps its machine identity while the shell generation moves", async ({
  request,
}) => {
  const response = await request.get("/sw.js");
  expect(response.ok()).toBeTruthy();
  const sw = await response.text();

  // Stable machine identity — none of these are branding, and renaming any of
  // them would strand queued field work or break the cache header contract.
  expect(sw).toContain('const QUEUE_DB = "beez-trackz-offline"');
  expect(sw).toContain('const QUEUE_STORE = "mutations"');
  expect(sw).toContain('headers.set("X-Beez-Cache", "stale")');
  expect(sw).toMatch(/const SHELL_CACHE = "beez-trackz-shell-/);
  expect(sw).toMatch(/const DATA_CACHE = "beez-trackz-api-/);

  // The shell generation is bumped once for the branded assets, so activate()
  // drops the pre-brand shell. The suffix rides after the build id.
  expect(sw).toMatch(/const SHELL_CACHE = "beez-trackz-shell-[^"]*-b2";/);

  // The eviction sweep still keys off the stable prefix, so the previous
  // generation is collected rather than accumulating.
  expect(sw).toContain('key.startsWith("beez-trackz-")');
});
