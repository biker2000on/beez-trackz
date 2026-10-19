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

test("detail pages expose named record destinations and preserve URL state", async ({
  page,
}) => {
  await page.goto("/yard/apiaries/a1");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.getByRole("navigation",{name:"Apiary pages"}).getByRole("link", { name: "Map", exact:true }).click();
  await expect(page).toHaveURL(/\/layout/);

  await page.goto("/yard/apiaries/a1?tab=photos");
  await expect(page).toHaveURL("/yard/apiaries/a1/photos");

  await page.goto("/yard/hives/h1");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.getByRole("navigation",{name:"Hive pages"}).getByRole("link", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/\/timeline/);

  await page.goto("/yard/hives/h1?tab=queen");
  await expect(page).toHaveURL("/yard/hives/h1/queen");
});

// RecordPage (ui-coherence brief §5): the route layout draws the record
// header once, so every tab of a hive or an apiary has the same h1, the same
// action bar and the same tab strip, and the title is "Name · List · Brand".
// The strip comes from `contextualNavRoutes`, so the sidebar and Ctrl-K list
// the same tabs in the same order.
const HIVE_TABS = ["Overview", "Timeline", "Health", "Equipment", "Queen", "Photos"];
const APIARY_TABS = [
  "Overview",
  "Map",
  "Observations",
  "Flora",
  "Photos",
  "Timeline",
  "Labels",
  "Bulk record",
];

test("every hive tab shares one record header, action bar and tab strip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const tab of ["", "/timeline", "/health", "/equipment", "/queen", "/photos"]) {
    await page.goto(`/yard/hives/h1${tab}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A1");
    await expect(page).toHaveTitle(/^A1 · Hives · /);
    const strip = page.getByRole("navigation", { name: "Hive pages" });
    await expect(strip.getByRole("link")).toHaveText(HIVE_TABS);
    await expect(strip.getByRole("link", { name: HIVE_TABS[["", "/timeline", "/health", "/equipment", "/queen", "/photos"].indexOf(tab)] })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Voice inspection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log inspection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
    await expect(page.locator(".atlas-eyebrow")).toHaveCount(0);
  }
});

test("every apiary tab shares one record header and the Map tab claims the bare URL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const tab of ["", "/overview", "/layout", "/inspections", "/flora", "/photos", "/timeline", "/labels", "/bulk"]) {
    await page.goto(`/yard/apiaries/a1${tab}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Test Yard");
    await expect(page).toHaveTitle(/^Test Yard · Apiary list · /);
    const strip = page.getByRole("navigation", { name: "Apiary pages" });
    await expect(strip.getByRole("link")).toHaveText(APIARY_TABS);
    await expect(page.getByRole("link", { name: "Record visit" })).toBeVisible();
    await expect(page.locator(".atlas-eyebrow")).toHaveCount(0);
  }
  await page.goto("/yard/apiaries/a1");
  await expect(
    page.getByRole("navigation", { name: "Apiary pages" }).getByRole("link", { name: "Map", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

// Record tabs never wrap onto a second line: at phone width the strip
// scrolls sideways inside its own box and the active tab is in view.
test("record tab strips stay on one line at 375px and scroll the active tab into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const [path, name] of [
    ["/yard/apiaries/a1/bulk", "Apiary pages"],
    ["/yard/hives/h1/photos", "Hive pages"],
  ] as const) {
    await page.goto(path);
    const strip = page.getByRole("navigation", { name });
    const tops = new Set<number>();
    for (const link of await strip.getByRole("link").all()) {
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      tops.add(Math.round(box?.y ?? 0));
    }
    expect(tops.size, `${name} wrapped onto more than one line`).toBe(1);
    const active = strip.getByRole("link", { name: path.endsWith("bulk") ? "Bulk record" : "Photos" });
    await expect(active).toHaveAttribute("aria-current", "page");
    await expect(active).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows the viewport`).toBeLessThanOrEqual(0);
  }
});

// The Stock area (ui-coherence brief §3) owns the old Production pages. On
// desktop the sidebar lists the siblings and the page has no strip of its
// own; on a phone the page header carries one "Area · Page" disclosure, the
// same seven rows on every Stock page, including the palette-only ones.
const STOCK_PAGES = [
  "On hand",
  "Active batches",
  "Harvests",
  "Bottling",
  "Lots & labels",
  "Hive products",
  "Movements",
];

test("Stock pages share one phone disclosure and no desktop strip", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/production");
  await expect(
    page.getByRole("heading", { name: "Active batches", level: 1 }),
  ).toHaveCount(1);
  await expect(page).toHaveTitle(/^Active batches · Stock · /);
  await expect(page.getByRole("navigation", { name: "Stock pages" })).toHaveCount(0);
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await expect(sidebar.getByRole("link", { name: "Active batches" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Only the active area is expanded by default.
  await expect(sidebar.getByRole("link", { name: "Market day" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/production", "/production/serials"]) {
    await page.goto(path);
    const disclosure = page.getByRole("navigation", { name: "Stock pages" });
    await page.getByText(/^Stock · /).click();
    await expect(disclosure.getByRole("link")).toHaveText(STOCK_PAGES);
  }
});

test("insights pages have no section strip at any width, and the phone disclosure fits", async ({
  page,
}) => {
  for (const width of [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/insights/finance");
    await expect(
      page.getByRole("navigation", { name: "Insights sections" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Finance");
    await expect(page).toHaveTitle(/^Finance · Insights · /);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/insights/finance");
  await page.getByText("Insights · Finance").click();
  const links = page
    .getByRole("navigation", { name: "Insights pages" })
    .getByRole("link");
  await expect(links).toHaveText([
    "Insights",
    "Outcomes",
    "Finance",
    "Sales & planning",
    "Compliance packet",
    "Folio reconciliation",
  ]);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
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

// Today is the phone bar's first slot and Apiaries its second, for every
// role: Saturday work starts in the yard, so no admin-only area may push it
// off the bar. The bar has five slots — four areas plus More — and More is
// where Setup lives on a phone (ui-coherence brief §3).
test("Today and Apiaries remain pinned in a five-slot mobile bottom bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stock/movements");
  const mainNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(mainNav.locator("li")).toHaveCount(5);
  await expect(mainNav.getByRole("link")).toHaveText([
    "Today",
    "Apiaries",
    "Stock",
    "Sales",
  ]);
  await expect(mainNav.getByRole("link", { name: "Stock" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Every bar label is at least 11px: a gloved thumb in sunlight reads it.
  for (const label of await mainNav.locator("a, button").all()) {
    const size = await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(11);
  }

  await mainNav.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet.getByRole("link", { name: "Insights", exact: true })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Setup", exact: true })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "My preferences" })).toBeVisible();
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
