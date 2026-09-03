import { expect, test, type Page } from "@playwright/test";

// These routes share one Next.js development server. Serial execution avoids
// cold-compilation races while keeping the browser assertions deterministic.
test.describe.configure({ mode: "serial" });

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
          elevationM: null,
          elevationSource: null,
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
    if (path.endsWith("/analytics/varroa")) {
      return route.fulfill({
        json: {
          hives: [],
          overThresholdCount: 0,
          treatments: [],
          thresholdPer100: 3,
          thresholdPerDay: 9,
          checkIntervalDays: 30,
        },
      });
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
  await page.goto("/yard/apiaries/a1");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "Layout" }).click();
  await expect(page).toHaveURL(/tab=layout/);

  await page.goto("/yard/apiaries/a1?tab=photos");
  await expect(page).toHaveURL("/yard/apiaries/a1/photos");

  await page.goto("/yard/hives/h1");
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/tab=timeline/);

  await page.goto("/yard/hives/h1?tab=queen");
  await expect(page).toHaveURL("/yard/hives/h1/queen");
});

test("Production keeps the same workflow groups on hidden detail routes", async ({
  page,
}) => {
  await page.goto("/production");
  const nav = page.getByRole("navigation", { name: "Production sections" });
  await expect(nav.getByRole("link")).toHaveText([
    "Overview",
    "Production",
  ]);

  await page.goto("/production/activity");
  await expect(nav.getByRole("link")).toHaveText([
    "Overview",
    "Production",
  ]);
});

test("insights navigation fits tablet width and the insights home has no duplicate strip", async ({
  page,
}) => {
  await page.goto("/insights");
  await expect(
    page.getByRole("navigation", { name: "Insights sections" }),
  ).toHaveCount(0);

  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/insights/finance");
    const links = page
      .getByRole("navigation", { name: "Insights sections" })
      .getByRole("link");
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
  }
});

// Record tab strips and wide comparison tables are allowed to scroll
// sideways inside their own container; the page itself never may.
test("phone-width pages never scroll the document sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of [
    "/yard/apiaries/a1",
    "/yard/hives/h1",
    "/yard/hives/h1?tab=timeline",
    "/insights/finance",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows the viewport`).toBeLessThanOrEqual(0);
  }
});

// Today is the phone bar's first slot and Yard its second, for every role
// (design 2026-09-03 §2.2): Saturday work starts in the yard, so no
// admin-only area may push it off the bar.
test("Today and Yard remain pinned in the mobile bottom bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/production/activity");
  const mainNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(mainNav.getByRole("link", { name: "Today" })).toBeVisible();
  await expect(mainNav.getByRole("link", { name: "Yard" })).toBeVisible();
});

test("command palette follows keyboard selection without horizontal overflow", async ({
  page,
}) => {
  const hives = Array.from({ length: 12 }, (_, index) => ({
    id: `h${index + 1}`,
    apiaryId: "a1",
    apiaryName: "North Ridge Apiary With A Deliberately Long Descriptive Name",
    positionLabel: `Hive Position ${index + 1} With Extra Descriptive Context`,
    status: "active",
    isArchived: false,
  }));
  await page.route("**/api/v1/hives?includeArchived=true", (route) =>
    route.fulfill({ json: hives }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/yard/hives");

  const searchButton = page.getByRole("button", { name: "Search everything" });
  await expect(searchButton).toBeVisible();
  expect(
    await searchButton.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const input = dialog.getByRole("combobox", { name: "Search commands" });
  await input.fill("hive position");
  await expect(
    dialog.getByText("Hive Position 1", { exact: false }).first(),
  ).toBeVisible();
  for (let index = 0; index < 20; index += 1) {
    await input.press("ArrowDown");
  }

  const activeCommand = dialog.locator('[role="option"][aria-selected="true"]');
  await expect(activeCommand).toHaveCount(1);
  const measurements = await activeCommand.evaluate((element) => {
    const results = element.closest<HTMLElement>("[data-command-results]");
    const palette = element.closest<HTMLElement>('[role="dialog"]');
    if (!results || !palette) throw new Error("Command palette structure missing");
    const itemBounds = element.getBoundingClientRect();
    const resultsBounds = results.getBoundingClientRect();
    return {
      itemVisible:
        itemBounds.top >= resultsBounds.top &&
        itemBounds.bottom <= resultsBounds.bottom,
      resultsScrolled: results.scrollTop > 0,
      resultsFit: results.scrollWidth <= results.clientWidth,
      paletteFit: palette.scrollWidth <= palette.clientWidth,
      paletteWidth: palette.clientWidth,
    };
  });

  expect(measurements.itemVisible).toBe(true);
  expect(measurements.resultsScrolled).toBe(true);
  expect(measurements.resultsFit).toBe(true);
  expect(measurements.paletteFit).toBe(true);
  expect(measurements.paletteWidth).toBeGreaterThanOrEqual(700);
});
