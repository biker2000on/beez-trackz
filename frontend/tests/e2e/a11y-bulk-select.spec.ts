import { expect, test, type Page } from "@playwright/test";

// One development server, one route set: keep these serial so the cold
// compile of /hives happens once.
test.describe.configure({ mode: "serial" });

const HIVES = [
  {
    id: "h1",
    apiaryId: "a1",
    apiaryName: "Test Yard",
    positionLabel: "A1",
    status: "active",
    installedDate: null,
    isArchived: false,
  },
  {
    id: "h2",
    apiaryId: "a1",
    apiaryName: "Test Yard",
    positionLabel: "A2",
    status: "active",
    installedDate: null,
    isArchived: false,
  },
];

async function mockApp(page: Page) {
  // Table view is a localStorage preference read after mount.
  await page.addInitScript(() => {
    window.localStorage.setItem("beez.hives.view", "table");
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "A11y test",
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "A11y test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/hives")) return route.fulfill({ json: HIVES });
    if (path.endsWith("/apiaries")) {
      return route.fulfill({
        json: [{ id: "a1", name: "Test Yard", hiveCount: 2 }],
      });
    }
    return route.fulfill({ json: [] });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

test("hive table rows are selectable from the keyboard", async ({ page }) => {
  await page.goto("/yard/hives");
  await page.getByRole("button", { name: "Bulk select" }).click();

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("aria-selected", "false");

  // No mouse: focus the row and press Space, the way the card branch reacts
  // to Enter/Space on its button.
  await rows.first().focus();
  await page.keyboard.press(" ");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("1 selected")).toBeVisible();

  await rows.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("2 selected")).toBeVisible();

  await page.keyboard.press(" ");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(page.getByText("1 selected")).toBeVisible();
});

test("leaving bulk mode keeps the selection; Clear all empties it", async ({
  page,
}) => {
  await page.goto("/yard/hives");
  await page.getByRole("button", { name: "Bulk select" }).click();
  await page.locator("tbody tr").first().click();
  await expect(page.getByText("1 selected")).toBeVisible();

  // Exit to open a hive for a second look, then come back.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("1 selected")).toHaveCount(0);
  await page.getByRole("button", { name: "Bulk select" }).click();
  await expect(page.getByText("1 selected")).toBeVisible();

  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.getByText("0 selected")).toBeVisible();
});

test("bulk mode still offers a way to open a hive", async ({ page }) => {
  await page.goto("/yard/hives");
  await page.getByRole("button", { name: "Bulk select" }).click();
  await expect(
    page.locator("tbody").getByRole("link", { name: "A1" }),
  ).toBeVisible();
});
