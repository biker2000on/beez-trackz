import { expect, test, type Page } from "@playwright/test";

/**
 * Stock pages render as a DataGrid: sortable headers, column filters, a
 * search box, empty ledger rows hidden behind a persisted "Show empty"
 * toggle, quantities in words people read ("2", "12.5 lb", "—"), and below
 * the md breakpoint every row becomes a card with a "Sort by" select.
 */

type Row = Record<string, unknown>;

function stockRow(overrides: Row): Row {
  return {
    itemId: "item-1",
    itemName: "Bulk honey",
    kind: "honey_bulk",
    unit: "lb",
    locationId: "home",
    locationName: "Home",
    lotId: null,
    lotCode: null,
    harvestLotId: null,
    condition: null,
    hiveId: null,
    onHand: "0.0000",
    reserved: "0.0000",
    available: "0.0000",
    countKnown: true,
    originKnown: true,
    holds: [],
    holdsKnown: true,
    ...overrides,
  };
}

const BULK_ROWS = [
  stockRow({
    lotId: "lot-sourwood",
    lotCode: "2026-Sourwood",
    harvestLotId: "hl-sourwood",
    onHand: "12.5000",
    available: "12.5000",
  }),
  stockRow({
    lotId: "lot-clover",
    lotCode: "2026-Clover",
    harvestLotId: "hl-clover",
    locationId: "market",
    locationName: "Crossroads Market",
    onHand: "40.0000",
    reserved: "5.0000",
    available: "35.0000",
  }),
  // Fully bottled: zero on hand, nothing reserved. Hidden by default.
  stockRow({
    lotId: "lot-spring",
    lotCode: "2025-Spring",
    harvestLotId: "hl-spring",
    onHand: "0.0000",
  }),
];

const JAR_ROWS = [
  stockRow({
    itemId: "jar-1lb",
    itemName: "1 pound",
    kind: "jar",
    unit: "count",
    locationId: "market",
    locationName: "Crossroads Market",
    lotCode: "2026-Sourwood",
    harvestLotId: "hl-sourwood",
    onHand: "2.0000",
    available: "2.0000",
  }),
  stockRow({
    itemId: "jar-gallon",
    itemName: "Gallon",
    kind: "jar",
    unit: "count",
    countKnown: false,
    onHand: "0.0000",
  }),
  stockRow({
    itemId: "jar-pint",
    itemName: "Pint",
    kind: "jar",
    unit: "count",
    onHand: "14.0000",
    available: "14.0000",
  }),
];

async function mockStock(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/auth/status")) {
      return route.fulfill({ json: { authenticated: true, setupComplete: true } });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: { id: "u", displayName: "Test", isAdmin: true, memberships: [] },
      });
    }
    if (path.endsWith("/stock")) {
      const kind = url.searchParams.get("kind");
      const rows =
        kind === "bulk_honey" ? BULK_ROWS : kind === "jar" ? JAR_ROWS : [];
      return route.fulfill({
        json: {
          asOf: "2026-10-01T12:00:00Z",
          freshness: { origin: "server", stale: false },
          rows,
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await mockStock(page);
});

test("bulk stock hides empty lots until Show empty, and remembers the choice", async ({
  page,
}) => {
  await page.goto("/stock/bulk");
  const grid = page.getByRole("table", { name: "Stock" });
  await expect(grid).toBeVisible();

  await expect(grid.getByRole("link", { name: "2026-Sourwood" })).toHaveAttribute(
    "href",
    "/production/lots/hl-sourwood",
  );
  await expect(grid.getByText("12.5 lb", { exact: true }).first()).toBeVisible();
  await expect(grid.getByText("12.5000")).toHaveCount(0);
  await expect(grid.getByText("2025-Spring")).toHaveCount(0);

  const toggle = page.getByRole("checkbox", { name: /Show empty \(1\)/ });
  await toggle.check();
  await expect(grid.getByRole("link", { name: "2025-Spring" })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("table", { name: "Stock" }).getByRole("link", { name: "2025-Spring" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /Show empty/ }).uncheck();
  await expect(page.getByText("2025-Spring")).toHaveCount(0);
});

test("finished goods: counts read as whole numbers, unknown is a dash, filters and sort work", async ({
  page,
}) => {
  await page.goto("/stock/finished");
  const grid = page.getByRole("table", { name: "Stock" });
  const onePound = grid.getByRole("row").filter({ hasText: "1 pound" });
  await expect(onePound).toBeVisible();
  await expect(onePound.getByRole("cell", { name: "2", exact: true }).first()).toBeVisible();
  await expect(grid.getByText("2.0000")).toHaveCount(0);
  await expect(grid.getByText(/count/)).toHaveCount(0);

  // A count that was never taken is a dash with an explanation, not "Unknown".
  const gallon = grid.getByRole("row").filter({ hasText: "Gallon" });
  await expect(gallon.getByLabel("Unknown").first()).toHaveText("—");

  // Location filter.
  await page.getByRole("combobox", { name: "Filter by location" }).selectOption("Crossroads Market");
  await expect(grid.getByRole("row").filter({ hasText: "Pint" })).toHaveCount(0);
  await expect(onePound).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by location" }).selectOption("");

  // Numbers sort largest first on the first click, then smallest first; the
  // uncounted row stays last either way.
  const onHand = grid.getByRole("columnheader", { name: "On hand" });
  await grid.getByRole("button", { name: "On hand" }).click();
  await expect(onHand).toHaveAttribute("aria-sort", "descending");
  await expect(grid.locator("tbody tr").first()).toContainText("Pint");
  await expect(grid.locator("tbody tr").last()).toContainText("Gallon");
  await grid.getByRole("button", { name: "On hand" }).click();
  await expect(onHand).toHaveAttribute("aria-sort", "ascending");
  await expect(grid.locator("tbody tr").first()).toContainText("1 pound");
  await expect(grid.locator("tbody tr").last()).toContainText("Gallon");
});

test("on a phone the stock grid becomes cards with search and a Sort by select", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/stock/finished");

  const cards = page.getByRole("list", { name: "Stock" });
  await expect(cards).toBeVisible();
  await expect(page.getByRole("table", { name: "Stock" })).toHaveCount(0);
  await expect(cards.locator("[data-grid-card]")).toHaveCount(3);

  const onePound = cards.locator("[data-grid-card]").filter({ hasText: "1 pound" });
  await expect(onePound.getByText("On hand", { exact: true })).toBeVisible();
  await expect(onePound.getByRole("link", { name: "2026-Sourwood" })).toHaveAttribute(
    "href",
    "/production/lots/hl-sourwood",
  );

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("onHand:desc");
  await expect(cards.locator("[data-grid-card]").first()).toContainText("Pint");

  await page.getByRole("searchbox", { name: "Search Stock" }).fill("gallon");
  await expect(cards.locator("[data-grid-card]")).toHaveCount(1);
  await expect(page.getByText("1 of 3")).toBeVisible();

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
