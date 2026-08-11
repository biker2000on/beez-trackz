import { expect, test, type Page } from "@playwright/test";

async function mockApp(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Navigation test",
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Navigation test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/apiaries/a1/weather")) {
      return route.fulfill({
        json: {
          apiaryId: "a1",
          source: "test",
          fetchedAt: "2026-01-01T00:00:00Z",
          alerts: [],
          feedingStatus: {
            activeFeeders: 0,
            lastFeedingAt: null,
            needsAttention: false,
          },
          forecast: {
            timezone: "UTC",
            current: {
              time: "2026-01-01T00:00:00Z",
              temperature_2m: 50,
              apparent_temperature: 50,
              relative_humidity_2m: 50,
              weather_code: 0,
              wind_speed_10m: 0,
              is_day: 1,
            },
            daily: {
              time: [],
              weather_code: [],
              temperature_2m_max: [],
              temperature_2m_min: [],
              precipitation_sum: [],
              precipitation_probability_max: [],
              wind_speed_10m_max: [],
            },
          },
        },
      });
    }
    if (path.endsWith("/apiaries/a1/bloom-predictions")) {
      return route.fulfill({ json: { predictions: [] } });
    }
    if (path.endsWith("/apiaries/a1")) {
      return route.fulfill({
        json: {
          id: "a1",
          name: "Test Yard",
          latitude: null,
          longitude: null,
          notes: null,
          canvasLayout: null,
          satelliteImageKey: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    if (path.endsWith("/hives/h1")) {
      return route.fulfill({
        json: {
          id: "h1",
          apiaryId: "a1",
          apiaryName: "Test Yard",
          positionLabel: "A1",
          standId: null,
          slotRow: null,
          slotCol: null,
          placement: null,
          facingDegrees: null,
          status: "active",
          installedDate: null,
          isArchived: false,
          deadoutDate: null,
          notes: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    if (path.endsWith("/honey/overview")) {
      return route.fulfill({
        json: {
          bulkOnHandLbs: 0,
          totalHarvestedLbs: 0,
          inventory: [],
        },
      });
    }
    if (path.endsWith("/analytics/survival")) {
      return route.fulfill({
        json: {
          survivalRate: 0,
          survived: 0,
          enteredWinter: 0,
          byApiary: [],
          byStand: [],
          byQueenLine: [],
        },
      });
    }
    if (path.endsWith("/analytics/yield")) {
      return route.fulfill({ json: { totalPounds: 0, byHive: [], byYear: [] } });
    }
    if (path.endsWith("/analytics/economics")) {
      return route.fulfill({ json: { apiaries: [] } });
    }
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

test("detail pages expose no more than three peer tabs and preserve URL state", async ({
  page,
}) => {
  await page.goto("/apiaries/a1");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "Layout" }).click();
  await expect(page).toHaveURL(/tab=layout/);

  await page.goto("/apiaries/a1?tab=photos");
  await expect(page).toHaveURL("/apiaries/a1/photos");

  await page.goto("/hives/h1");
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/tab=timeline/);

  await page.goto("/hives/h1?tab=queen");
  await expect(page).toHaveURL("/hives/h1/queen");
});

test("Honey keeps the same three workflow groups on hidden detail routes", async ({
  page,
}) => {
  await page.goto("/harvest");
  const nav = page.getByRole("navigation", { name: "Honey sections" });
  await expect(nav.getByRole("link")).toHaveText([
    "Overview",
    "Production",
    "Sales",
  ]);

  await page.goto("/harvest/activity");
  await expect(nav.getByRole("link")).toHaveText([
    "Overview",
    "Production",
    "Sales",
  ]);
});

test("report navigation fits tablet width and the report home has no duplicate strip", async ({
  page,
}) => {
  await page.goto("/reports");
  await expect(
    page.getByRole("navigation", { name: "Report sections" }),
  ).toHaveCount(0);

  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/reports/finance");
    const links = page
      .getByRole("navigation", { name: "Report sections" })
      .getByRole("link");
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
  }
});

test("Home remains pinned in the mobile bottom bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/harvest/activity");
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(mainNav.getByRole("link", { name: "Home" })).toBeVisible();
});
