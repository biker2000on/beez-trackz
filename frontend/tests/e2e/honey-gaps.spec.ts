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
            },
          ],
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

test("honey overview flags negative bulk and asks for harvests", async ({
  page,
}) => {
  await mockApp(page, { bulkOnHandLbs: -8.3, totalHarvestedLbs: 0 });
  await page.goto("/production");
  await expect(page.getByText("Bulk honey is short of what was jarred")).toBeVisible();
  await expect(page.getByRole("link", { name: "Record harvests" })).toBeVisible();
  await expect(page.getByText("Jars on the shelf exceed recorded harvests.")).toBeVisible();
});

test("market day refuses a paid sale when the jar has no price", async ({
  page,
}) => {
  await mockApp(page, { bulkOnHandLbs: 0, totalHarvestedLbs: 0 });
  await page.goto("/sales/market-day");
  await expect(page.getByText("No price")).toBeVisible();
  await page.getByRole("button", { name: /Pint/ }).first().click();
  await expect(
    page.getByText(/Set a default price on Pint/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeDisabled();
});
