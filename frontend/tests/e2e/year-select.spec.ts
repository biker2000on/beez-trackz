import { expect, test, type Page } from "@playwright/test";

/**
 * Season year is a dropdown everywhere, not a number box.
 *
 * The years offered come from `GET /meta/years` (earliest year the operator
 * has data for through the current year), newest first. A year in the URL
 * outside that span is still shown, a missing or odd answer falls back to the
 * current year back to 2020, and each page keeps its own default year.
 *
 * Every `/api/v1/**` read is `page.route`-mocked to the API's shapes, the way
 * `journeys.spec.ts` does it.
 */

test.describe.configure({ mode: "serial" });

const THIS_YEAR = new Date().getFullYear();

interface MockOptions {
  /** What `/meta/years` answers; `null` falls through to the `[]` default. */
  years?: { min: number; max: number; current: number } | null;
}

async function mockApp(page: Page, options: MockOptions = {}) {
  const yearRequests: { path: string; year: string | null }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Year test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Year test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith("/meta/years") && options.years) {
      return route.fulfill({ json: options.years });
    }
    if (path.endsWith("/expenses")) {
      yearRequests.push({ path, year: url.searchParams.get("year") });
      return route.fulfill({ json: [] });
    }
    if (path.endsWith("/folio-imports")) {
      return route.fulfill({
        json: {
          items: [],
          counts: {
            imported: 0,
            toCategorize: 0,
            expensesToCategorize: 0,
            incomeToCategorize: 0,
            conflicts: 0,
          },
          expenseCategories: [],
          otherIncomeCategories: [],
        },
      });
    }
    if (path.endsWith("/analytics/survival")) {
      const year = Number(url.searchParams.get("year"));
      yearRequests.push({ path, year: url.searchParams.get("year") });
      return route.fulfill({
        json: {
          winterYear: year,
          enteredWinter: 0,
          survived: 0,
          survivalRate: 0,
          byApiary: [],
          byStand: [],
          byQueenLine: [],
        },
      });
    }
    if (path.endsWith("/field/autopsy-summary")) {
      return route.fulfill({
        json: {
          year: Number(url.searchParams.get("year")),
          total: 0,
          moisture: 0,
          mold: 0,
          stores: [],
          clusterPositions: [],
          queenStatuses: [],
        },
      });
    }

    if (request.method() !== "GET") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: [] });
  });
  return { yearRequests };
}

function yearPicker(page: Page) {
  return page.getByRole("combobox", { name: "Season year" });
}

async function listedYears(page: Page): Promise<number[]> {
  await yearPicker(page).click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  return (await options.allTextContents()).map((text) => Number(text.trim()));
}

function range(top: number, bottom: number): number[] {
  const out: number[] = [];
  for (let year = top; year >= bottom; year -= 1) out.push(year);
  return out;
}

test("the Expenses year is a dropdown of the operator's years, newest first", async ({
  page,
}) => {
  const { yearRequests } = await mockApp(page, {
    years: { min: 2019, max: THIS_YEAR, current: THIS_YEAR },
  });
  await page.goto("/sales/expenses?year=2024");

  // No number box: a combobox showing the URL's year.
  await expect(page.getByRole("spinbutton", { name: "Season year" })).toHaveCount(0);
  await expect(yearPicker(page)).toHaveText("2024");

  expect(await listedYears(page)).toEqual(range(THIS_YEAR, 2019));

  await page.getByRole("option", { name: "2022", exact: true }).click();
  await expect(yearPicker(page)).toHaveText("2022");
  await expect(page).toHaveURL(/[?&]year=2022\b/);
  await expect
    .poll(() => yearRequests.some((r) => r.path.endsWith("/expenses") && r.year === "2022"))
    .toBe(true);
  // Expenses defaults to the current year when the URL has none.
  await page.goto("/sales/expenses");
  await expect(yearPicker(page)).toHaveText(String(THIS_YEAR));
});

test("a report keeps its last-season default and a year outside the span stays listed", async ({
  page,
}) => {
  const { yearRequests } = await mockApp(page, {
    years: { min: 2021, max: THIS_YEAR, current: THIS_YEAR },
  });

  // Survival defaults to last season, as it did with the number box.
  await page.goto("/insights/survival");
  await expect(yearPicker(page)).toHaveText(String(THIS_YEAR - 1));

  // A shared link from before the operator's data still shows its year.
  await page.goto("/insights/survival?year=2012");
  await expect(yearPicker(page)).toHaveText("2012");
  await expect
    .poll(() => yearRequests.some((r) => r.path.endsWith("/analytics/survival") && r.year === "2012"))
    .toBe(true);
  expect(await listedYears(page)).toEqual([...range(THIS_YEAR, 2021), 2012]);
});

test("without a years answer the dropdown falls back to this year back to 2020", async ({
  page,
}) => {
  // `/meta/years` falls through to the mock's `[]` default.
  await mockApp(page, { years: null });
  await page.goto("/sales/expenses");
  await expect(yearPicker(page)).toHaveText(String(THIS_YEAR));
  expect(await listedYears(page)).toEqual(range(THIS_YEAR, 2020));
});
