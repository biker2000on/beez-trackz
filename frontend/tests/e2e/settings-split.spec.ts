import { expect, test, type Page } from "@playwright/test";

import { CONFIG_OBJECTS } from "../../src/features/admin/config-registry";

/**
 * The settings split (design 2026-09-03 §6; wave 6).
 *
 * `/settings` rendered twelve accordions, nine of them behind one `isAdmin`
 * check, and the data behind them was a single `user_settings` row shared by
 * every account. Wave 6 replaces it with three surfaces:
 *
 *  - `/me` — My Preferences, every authenticated user, per-user data;
 *  - `/admin/setup` — Operation Setup, the catalogs and policies the
 *    workspaces work from;
 *  - `/admin` — Admin and Integrations, the credentials and access.
 *
 * Four things are pinned here, one per acceptance criterion in wave 6:
 * a non-admin reaches their own preferences and nothing else; two accounts'
 * themes are independent *in the request the UI makes*, not merely in the
 * screen; every configuration object has exactly one editor; and `/settings`
 * is gone rather than redirected.
 *
 * The backend half lands in parallel, so every read is `page.route`-mocked to
 * the contract the design names. That is deliberate: the shapes are the
 * contract, and this spec fails when the contract moves rather than when a
 * database happens to be empty.
 */

test.describe.configure({ mode: "serial" });

interface MockOptions {
  isAdmin?: boolean;
  theme?: string;
  /** Every mutation the page issues, as "METHOD path". */
  writes?: string[];
  /** Bodies of the writes, in the same order. */
  bodies?: unknown[];
}

const AI_SETTINGS = {
  transcription: { provider: "whisper", model: "" },
  recommendations: { provider: "claude", model: "" },
  imageAnalysis: { provider: "claude", model: "" },
  import: { provider: "claude", model: "" },
  apiKeys: {
    hasAnthropicKey: false,
    hasGoogleKey: false,
    ollamaUrl: "",
    whisperUrl: "",
  },
};

const GNUCASH_SETTINGS = {
  baseUrl: "",
  hasToken: false,
  bookGuid: "",
  bookName: "",
  rootCurrency: "USD",
  syncEnabled: false,
  accountMapping: {},
  lastSyncedAt: null,
  lastSyncAttemptAt: null,
  hasCursor: false,
  restoreState: "none",
  restorePending: false,
  saleLineKinds: ["jar"],
  expenseCategories: ["feed"],
};

function policyBody() {
  return {
    laborTrackingEnabled: false,
    miteThresholdPer100: null,
    miteThresholdPerDay: null,
    miteCheckIntervalDays: null,
    moistureThresholdPct: null,
    ntfy: {
      serverUrl: "",
      topic: "",
      hasAccessToken: false,
      enabled: false,
      eventKinds: [],
    },
  };
}

async function mockApp(page: Page, options: MockOptions = {}) {
  const isAdmin = options.isAdmin ?? true;
  // The per-user route is stateful, like the real one: a PUT changes what
  // the next GET returns, which is what the form's post-save refetch relies on.
  let theme = options.theme ?? "system";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (request.method() !== "GET") {
      options.writes?.push(`${request.method()} ${path}`);
      const body = request.postDataJSON();
      options.bodies?.push(body);
      if (path.endsWith("/me/preferences") && body && typeof body.theme === "string") {
        theme = body.theme;
      }
      return route.fulfill({ json: { success: true } });
    }

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Split test",
          isAdmin,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: isAdmin ? "user-admin" : "user-viewer",
          displayName: "Split test",
          email: null,
          isAdmin,
          hasPassword: true,
          memberships: isAdmin
            ? []
            : [{ apiaryId: "a1", apiaryName: "North Ridge", role: "viewer" }],
        },
      });
    }
    // The per-user half of the split: this route is keyed by the session's
    // own user, and it is the only place a theme is stored.
    if (path.endsWith("/me/preferences")) {
      return route.fulfill({
        json: {
          theme,
          defaultApiaryId: null,
          dateFormat: "MM/DD/YYYY",
          weightUnit: "oz",
          units: "us",
          temperatureUnit: null,
        },
      });
    }
    if (path.endsWith("/admin/policy")) {
      if (!isAdmin) {
        return route.fulfill({
          status: 403,
          json: { error: "admin access required" },
        });
      }
      return route.fulfill({ json: policyBody() });
    }
    if (path.endsWith("/settings/ai")) {
      return route.fulfill({ json: AI_SETTINGS });
    }
    if (path.endsWith("/settings/gnucash")) {
      return route.fulfill({ json: GNUCASH_SETTINGS });
    }
    if (path.endsWith("/settings/gnucash/rows")) {
      return route.fulfill({ json: { counts: {}, conflicts: [], failures: [] } });
    }
    if (path.endsWith("/settings/storage")) {
      return route.fulfill({
        json: {
          defaultBackend: "minio",
          fallbackBackend: "minio",
          immichConfigured: false,
          immichHealthy: null,
          counts: { minio: 0, immich: 0 },
        },
      });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: null } });
    }
    if (path.endsWith("/ops/labor/current")) {
      return route.fulfill({ json: { enabled: false, current: null } });
    }
    return route.fulfill({ json: [] });
  });
}

test("a non-admin gets their own preferences and nothing else", async ({
  page,
}) => {
  await mockApp(page, { isAdmin: false });

  await page.goto("/me");
  await expect(
    page.getByRole("heading", { name: "My preferences" }),
  ).toBeVisible();
  // The preference editor itself, not just the page shell: this used to be
  // inside the admin-only block.
  await expect(page.locator('[data-config-editor="preferences"]')).toBeVisible();
  await expect(page.getByLabel("Theme", { exact: true })).toBeVisible();

  // No Admin entry in the rail, and no way to reach an admin surface from it.
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Admin" }),
  ).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.getByText("Administrator access required")).toBeVisible();
  await expect(page.locator("[data-config-editor]")).toHaveCount(0);

  await page.goto("/admin/setup");
  await expect(page.getByText("Administrator access required")).toBeVisible();
  await expect(page.locator("[data-config-editor]")).toHaveCount(0);
});

test("one account's theme change cannot reach another account", async ({
  browser,
}) => {
  // Two browser contexts, two sessions, two stored themes. Before wave 6 both
  // read and wrote the same `user_settings` row through `PUT /settings/
  // preferences`, so the second load would have shown the first's choice.
  const dark = await browser.newContext();
  const light = await browser.newContext();
  try {
    const darkPage = await dark.newPage();
    const lightPage = await light.newPage();
    const darkWrites: string[] = [];
    const darkBodies: unknown[] = [];
    await mockApp(darkPage, {
      theme: "dark",
      writes: darkWrites,
      bodies: darkBodies,
    });
    await mockApp(lightPage, { theme: "light" });

    await darkPage.goto("/me");
    await lightPage.goto("/me");
    await expect(darkPage.getByLabel("Theme", { exact: true })).toHaveText("Dark");
    await expect(lightPage.getByLabel("Theme", { exact: true })).toHaveText("Light");

    // The first account changes its theme…
    await darkPage.getByLabel("Theme", { exact: true }).click();
    await darkPage.getByRole("option", { name: "System" }).click();
    await expect(darkPage.getByLabel("Theme", { exact: true })).toHaveText("System");

    // …through its own route, carrying no operation-wide field with it.
    expect(darkWrites).toEqual(["PUT /api/v1/me/preferences"]);
    const body = darkBodies[0] as Record<string, unknown>;
    expect(body.theme).toBe("System".toLowerCase());
    for (const operationWide of [
      "laborTrackingEnabled",
      "miteThresholdPer100",
      "miteThresholdPerDay",
      "miteCheckIntervalDays",
      "moistureThresholdPct",
      "ntfy",
    ]) {
      expect(body).not.toHaveProperty(operationWide);
    }

    // …and the second account, reloaded, still has its own.
    await lightPage.reload();
    await expect(lightPage.getByLabel("Theme", { exact: true })).toHaveText("Light");
  } finally {
    await dark.close();
    await light.close();
  }
});

/**
 * Surfaces that must be checked for a stray editor: the three split surfaces
 * plus every workspace that hosted, or contextually links to, a configuration
 * object that used to be dual-homed (design §6.5).
 */
const SURFACES = [
  "/me",
  "/admin",
  "/admin/setup",
  "/yard/queue",
  "/yard/hives",
  "/production/jars",
  "/production/varietals",
  "/sales/market-day",
  "/equipment",
  "/equipment/types",
  "/insights/compliance",
  "/insights/reconciliation",
];

test("every configuration object has exactly one editor", async ({ page }) => {
  await mockApp(page);
  const found = new Map<string, string[]>();

  for (const surface of SURFACES) {
    await page.goto(surface);
    // The heading is rendered by the page itself, so waiting on it means the
    // route (not just the shell) is mounted before anything is counted.
    await expect(page.locator("h1")).toBeVisible();
    const keys = await page
      .locator("[data-config-editor]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-config-editor") ?? ""),
      );
    for (const key of keys) {
      found.set(key, [...(found.get(key) ?? []), surface]);
    }
  }

  // Every registered object was found, on exactly the surface that owns it.
  const expected = new Map(
    CONFIG_OBJECTS.map((object) => [object.key, [object.href]] as const),
  );
  expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected));

  // And nothing rendered an editor that is not in the registry at all.
  for (const key of found.keys()) {
    expect(
      CONFIG_OBJECTS.some((object) => object.key === key),
      `${key} renders an editor but is not in the config registry`,
    ).toBe(true);
  }
});

test("a workspace links to its catalog instead of editing it", async ({
  page,
}) => {
  await mockApp(page);

  // S13: jar sizes were invisible from the page that spends them.
  await page.goto("/production/jars");
  await expect(
    page.getByRole("link", { name: "Manage jar sizes" }),
  ).toHaveAttribute("href", "/admin/setup#jar-sizes");

  // The anchor opens that section rather than landing on closed cards.
  await page.goto("/admin/setup#jar-sizes");
  await expect(page.locator('[data-config-editor="jar-sizes"]')).toBeVisible();
});

test("/settings is gone, and it does not redirect", async ({ request }) => {
  const response = await request.get("/settings", { maxRedirects: 0 });
  expect(response.status()).toBe(404);
});
