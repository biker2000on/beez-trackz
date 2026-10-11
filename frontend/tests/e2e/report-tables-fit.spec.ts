import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Report tables fit the page instead of scrolling sideways.
 *
 * The shared DataGrid wraps header labels, shows the idle sort arrow only on
 * hover, folds `priority: "secondary"` columns into an expandable detail row
 * when the table would overflow, and falls back to cards when even that is
 * too wide. These checks hold the report pages to it at laptop widths and
 * check the phone card layout of Apiary economics.
 *
 * Every `/api/v1/**` read is `page.route`-mocked to the API's shapes, the way
 * `journeys.spec.ts` does it.
 */

const THIS_YEAR = new Date().getFullYear();

const ECONOMICS = {
  year: THIS_YEAR - 1,
  apiaries: [
    {
      apiaryId: "ap-home",
      apiaryName: "Home Yard by the Creek",
      harvestedPounds: 412.5,
      producingHives: 9,
      revenueAllocated: 12450.75,
      expenses: 3987.12,
      margin: 8463.63,
      poundsPerHive: 45.8,
      feedCostPerColony: 38.4,
      treatmentCostPerColony: 21.9,
      enteredWinter: 12,
      survivedWinter: 9,
      winterSurvivalRate: 75,
      splitsCreated: 6,
      splitChildrenSurviving: 4,
      queensIntroduced: 5,
      introducedQueensActive: 3,
    },
    {
      apiaryId: "ap-ridge",
      apiaryName: "Sourwood Ridge",
      harvestedPounds: 1188,
      producingHives: 22,
      revenueAllocated: 35860.4,
      expenses: 11240.65,
      margin: 24619.75,
      poundsPerHive: 54,
      feedCostPerColony: 112.35,
      treatmentCostPerColony: 64.2,
      enteredWinter: 26,
      survivedWinter: 21,
      winterSurvivalRate: 80.8,
      splitsCreated: 14,
      splitChildrenSurviving: 11,
      queensIntroduced: 12,
      introducedQueensActive: 10,
    },
  ],
};

const SURVIVAL_GROUP = (key: string, label: string) => ({
  key,
  label,
  enteredWinter: 18,
  survived: 14,
  survivalRate: 77.8,
});

const PROFITABILITY = {
  year: THIS_YEAR,
  revenue: 48311.15,
  expenses: 15227.77,
  grossMargin: 33083.38,
  marginPercent: 68.5,
  harvestedPounds: 1600.5,
  costPerHarvestedPound: 9.51,
  costPerJarSold: 4.12,
  inventoryValue: 8120,
  jarsSold: 3696,
  breakEvenByJarSize: [
    { jarSizeId: "j1", label: "1 lb Queenline", breakEvenPrice: 6.25, defaultPrice: 14, onHand: 120 },
    { jarSizeId: "j2", label: "3 lb Muth jar", breakEvenPrice: 16.8, defaultPrice: null, onHand: 18 },
  ],
  byChannel: [
    { channel: "farmers_market", revenue: 21450.5, orderCount: 812 },
    { channel: "wholesale", revenue: 18920, orderCount: 41 },
  ],
  byJarSize: [
    { jarSizeId: "j1", label: "1 lb Queenline", jarsSold: 2410, revenue: 33740, estimatedHoneyCost: 9120, estimatedMargin: 24620 },
  ],
  byHarvestLot: [
    { harvestLotId: "hl1", lotCode: "2026-SOURWOOD-01", season: "2026 Summer", harvestedPounds: 820, revenue: 26240.5, expenses: 7120.4, margin: 19120.1 },
  ],
  bySeason: [
    { season: "2026 Summer", harvestedPounds: 1180, revenue: 36210.9, expenses: 10120.3, margin: 26090.6 },
  ],
  byKind: [
    { kind: "honey", revenue: 41200, cost: 11040, margin: 30160, costedLines: 410, totalLines: 432 },
  ],
};

const PLAN = {
  lookbackDays: 90,
  horizonDays: 60,
  honeyRequiredLbs: 412,
  projectedRevenue: 9870,
  bulkOnHandLbs: 900,
  bulkReservedForWholesaleLbs: 120,
  bulkAvailableAfterPlanLbs: 368,
  releaseAlertSubscribers: 42,
  recommendations: [
    { jarSizeId: "j1", label: "1 lb Queenline", onHand: 120, soldInLookback: 640, projectedDemand: 430, recommendedToBottle: 310, packagingRequired: 310, honeyRequiredLbs: 310, projectedRevenue: 4340 },
    { jarSizeId: "j2", label: "12 oz Bear", onHand: 24, soldInLookback: 210, projectedDemand: 140, recommendedToBottle: 116, packagingRequired: 116, honeyRequiredLbs: 87, projectedRevenue: 1276 },
  ],
};

const EXPENSES = [
  {
    id: "e1",
    expenseDate: `${THIS_YEAR}-04-12`,
    category: "Equipment",
    description: "Deep boxes, frames and foundation for the spring splits",
    amount: 642.18,
    apiaryId: "ap-ridge",
    apiaryName: "Sourwood Ridge",
    hiveId: null,
    hiveName: null,
    harvestLotId: null,
    lotCode: null,
    season: null,
    vendor: "Mann Lake",
    quantity: null,
    unit: null,
    notes: null,
  },
];

async function mockReports(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const year = Number(url.searchParams.get("year")) || THIS_YEAR;

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Report test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Report test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith("/meta/years")) {
      return route.fulfill({ json: { min: 2020, max: THIS_YEAR, current: THIS_YEAR } });
    }
    if (path.endsWith("/analytics/economics")) {
      return route.fulfill({ json: { ...ECONOMICS, year } });
    }
    if (path.endsWith("/analytics/survival")) {
      return route.fulfill({
        json: {
          winterYear: year,
          enteredWinter: 36,
          survived: 28,
          survivalRate: 77.8,
          byApiary: [SURVIVAL_GROUP("a1", "Home Yard by the Creek")],
          byStand: [SURVIVAL_GROUP("s1", "North stand")],
          byQueenLine: [SURVIVAL_GROUP("q1", "Saskatraz, open mated")],
        },
      });
    }
    if (path.endsWith("/field/autopsy-summary")) {
      return route.fulfill({
        json: { year, total: 0, moisture: 0, mold: 0, stores: [], clusterPositions: [], queenStatuses: [] },
      });
    }
    if (path.endsWith("/analytics/yield")) {
      return route.fulfill({
        json: {
          year,
          totalPounds: 1600.5,
          byHive: [
            { hiveId: "h1", hiveName: "Ridge 07 — Big Bertha", apiaryId: "ap-ridge", apiaryName: "Sourwood Ridge", pounds: 142.5 },
          ],
          byApiary: [{ apiaryId: "ap-ridge", apiaryName: "Sourwood Ridge", pounds: 1188 }],
          byYear: [{ year, pounds: 1600.5 }],
        },
      });
    }
    if (path.endsWith("/analytics/profitability")) {
      return route.fulfill({ json: { ...PROFITABILITY, year } });
    }
    if (path.endsWith("/honey/production-plan")) {
      return route.fulfill({ json: PLAN });
    }
    if (path.endsWith("/expenses")) {
      return route.fulfill({ json: EXPENSES });
    }
    if (path.endsWith("/folio-imports")) {
      return route.fulfill({
        json: {
          items: [],
          counts: { imported: 0, toCategorize: 0, expensesToCategorize: 0, incomeToCategorize: 0, conflicts: 0 },
          expenseCategories: [],
          otherIncomeCategories: [],
        },
      });
    }

    if (request.method() !== "GET") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: [] });
  });
}

/** Every rendered grid container: none may scroll sideways. */
async function expectNoSidewaysScroll(page: Page) {
  const grids = page.locator("[data-grid-mode]");
  await expect(grids.first()).toBeVisible();
  const overflows = await grids.evaluateAll((elements) =>
    elements
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `${el.querySelector("[aria-label]")?.getAttribute("aria-label")}: ${el.scrollWidth} > ${el.clientWidth}`),
  );
  expect(overflows).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

function economicsGrid(page: Page): Locator {
  return page.locator("[data-grid-mode]").filter({
    has: page.getByLabel("Apiary economics", { exact: true }),
  });
}

test.beforeEach(async ({ page }) => {
  await mockReports(page);
});

test("Apiary economics fits a 1280px laptop as a table with short, explained headers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/insights/economics");

  const table = page.getByRole("table", { name: "Apiary economics" });
  await expect(table.getByRole("row").filter({ hasText: "Sourwood Ridge" })).toBeVisible();
  await expect(economicsGrid(page)).toHaveAttribute("data-grid-mode", "table");

  // The short header carries its long form as a tooltip.
  const revenue = table.getByRole("columnheader", { name: "Revenue", exact: true });
  await expect(revenue).toHaveAttribute("title", "Revenue (invoiced)");
  await expect(table.getByRole("columnheader", { name: "Revenue (invoiced)" })).toHaveCount(0);

  await expectNoSidewaysScroll(page);

  // Sorting still works from the header.
  await table.getByRole("button", { name: "Margin" }).click();
  await expect(table.getByRole("columnheader", { name: "Margin" })).toHaveAttribute(
    "aria-sort",
    /ascending|descending/,
  );
});

for (const width of [1024, 1440]) {
  test(`Apiary economics has no sideways scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/insights/economics");
    await expect(page.getByText("Sourwood Ridge").first()).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Whatever columns gave way are still one click (or one card) away.
    const grid = economicsGrid(page);
    if ((await grid.getAttribute("data-grid-fit")) === "compact") {
      const row = page.getByRole("row").filter({ hasText: "Sourwood Ridge" });
      await row.getByRole("button", { name: "Show more details" }).click();
      await expect(page.locator("[data-grid-detail]")).toContainText("Introduced queens active");
      await expectNoSidewaysScroll(page);
    }
  });
}

test("on a phone Apiary economics is readable cards with the long labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 844 });
  await page.goto("/insights/economics");

  const cards = page.getByRole("list", { name: "Apiary economics" });
  await expect(cards.locator("[data-grid-card]")).toHaveCount(2);
  await expect(page.getByRole("table", { name: "Apiary economics" })).toHaveCount(0);

  const ridge = cards.locator("[data-grid-card]").filter({ hasText: "Sourwood Ridge" });
  await expect(ridge.getByText("Revenue (invoiced)", { exact: true })).toBeVisible();
  await expect(ridge.getByText("Introduced queens active", { exact: true })).toBeVisible();
  await expect(ridge.getByText("$35,860.40")).toBeVisible();

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

for (const route of [
  "/insights/survival",
  "/insights/yield",
  "/insights/profitability",
  "/insights/bottling",
  "/sales/expenses",
]) {
  test(`${route} tables do not scroll sideways at 1280px`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(route);
    await expect(page.locator("[data-grid-mode]").first()).toBeVisible();
    await expect(page.locator("tbody tr, [data-grid-card]").first()).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
}
