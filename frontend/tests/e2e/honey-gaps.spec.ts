import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function mockApp(
  page: Page,
  overview: { bulkOnHandLbs: number; totalHarvestedLbs: number },
) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "QA",
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "QA",
          email: "qa@example.com",
          isAdmin: true,
          hasPassword: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/honey/overview")) {
      return route.fulfill({
        json: {
          bulkOnHandLbs: overview.bulkOnHandLbs,
          totalHarvestedLbs: overview.totalHarvestedLbs,
          inventory: [{ jarSizeId: "pint", label: "Pint", onHand: 6 }],
          totalRevenue: 0,
        },
      });
    }
    if (path.endsWith("/honey/inventory")) {
      return route.fulfill({
        json: [
          {
            jarSizeId: "pint",
            label: "Pint",
            honeyOz: 16,
            defaultPrice: 0,
            onHand: 6,
          },
        ],
      });
    }
    if (path.endsWith("/stock-locations/inventory")) {
      return route.fulfill({
        json: {
          locations: [
            {
              id: "home",
              name: "Home",
              slug: "home",
              isHome: true,
              isConsignment: false,
              customerId: null,
              customerName: null,
              priceBasis: "retail",
              commissionBps: null,
              wholesalePriceListId: null,
              wholesalePriceListName: null,
              settlementCadence: "monthly",
              address: null,
              notes: null,
              isActive: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              onHandUnits: 6,
              outstandingBalance: 0,
            },
          ],
          items: [
            {
              jarSizeId: "pint",
              productId: null,
              label: "Pint",
              kind: "jar",
              unitPrice: null,
              total: 6,
              byLocation: { home: 6 },
              // Market day lists varietal × size × lot rows, so the pints
              // need a lot to appear at all.
              lots: [
                {
                  harvestLotId: "lot-sourwood",
                  lotCode: "2026-SOURWOOD-01",
                  varietalName: "Sourwood",
                  total: 6,
                  byLocation: { home: 6 },
                },
              ],
            },
          ],
        },
      });
    }
    if (path.endsWith("/production/workbench")) {
      // An empty workbench whose read model reports the bulk balance below
      // zero (bulkShortLbs), the same balance /honey/overview reports.
      return route.fulfill({
        json: {
          year: 2026,
          asOf: "2026-06-01T12:00:00Z",
          freshness: { origin: "server", cachedAt: null, stale: false },
          commands: [],
          openSessions: [],
          bulkOnHand: [],
          lotsAwaitingBottling: [],
          jarStock: [],
          productBatches: [],
          bulkShortLbs:
            overview.bulkOnHandLbs < 0
              ? (-overview.bulkOnHandLbs).toFixed(3)
              : null,
        },
      });
    }
    if (path.endsWith("/market-day/reconciliation")) {
      return route.fulfill({
        json: {
          orderCount: 0,
          grossSales: 0,
          amountCollected: 0,
          balanceDue: 0,
          breakdown: [],
        },
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("production workbench flags negative bulk and asks for harvests", async ({
  page,
}) => {
  await mockApp(page, { bulkOnHandLbs: -8.3, totalHarvestedLbs: 0 });
  await page.goto("/production");
  const alert = page.getByTestId("workbench-bulk-short");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("data-short-lbs", "8.300");
  await expect(alert.getByText("Bulk honey is short of what was jarred")).toBeVisible();
  await expect(alert.getByText("Jars on the shelf exceed recorded harvests.")).toBeVisible();
  await expect(alert.getByRole("link", { name: "Record harvests" })).toHaveAttribute(
    "href",
    "/production/harvests",
  );
});

test("production workbench says nothing about bulk when harvests cover the jars", async ({
  page,
}) => {
  await mockApp(page, { bulkOnHandLbs: 12, totalHarvestedLbs: 40 });
  await page.goto("/production");
  await expect(page.getByRole("heading", { name: "Active batches" })).toBeVisible();
  await expect(page.getByTestId("workbench-panel").first()).toBeVisible();
  await expect(page.getByTestId("workbench-bulk-short")).toHaveCount(0);
});

test("market day refuses a paid sale when the jar has no price", async ({
  page,
}) => {
  await mockApp(page, { bulkOnHandLbs: 0, totalHarvestedLbs: 0 });
  await page.goto("/sales/market-day");
  // One row per varietal × size × lot; an unpriced size says so on its row.
  await expect(page.getByText(/2026-SOURWOOD-01 · 6 left · No price/)).toBeVisible();
  await page.getByRole("button", { name: /Add one Sourwood · Pint/ }).click();
  await expect(
    page.getByText(/Set a price on Sourwood · Pt/),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Cash" }).click();
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeDisabled();
});
