import { expect, test, type Page } from "@playwright/test";

// Stock › Movements: the movement ledger as a server-sorted, server-filtered
// DataGrid with keyset-paged infinite scroll and desktop selection
// conventions (click, shift-click range, ctrl/cmd toggle, shift+arrow,
// Escape, select all loaded). One dev server: keep these serial.
test.describe.configure({ mode: "serial" });

const TOTAL = 120;

interface MockEntry {
  id: string;
  date: string;
  type: string;
  description: string;
  amountLbs: number | null;
  quantity: number | null;
  totalAmount: number | null;
  notes: string | null;
  isReversal: boolean;
  reversesMovementId: string | null;
  cancelled: boolean;
  item: string;
  itemKey: string;
  itemCount: number;
  varietal: string | null;
  lotCode: string | null;
  lotCount: number;
  fromLocation: string | null;
  toLocation: string | null;
  qty: number;
  qtyUnit: string;
}

const TYPE_LABEL: Record<string, string> = {
  jarring: "jarring",
  jar_adjustment: "adjustment",
};

// Newest first, three entries a day, so pages cross day groups. Jarrings add
// a varying number of jars; adjustments take one away.
const ENTRIES: MockEntry[] = Array.from({ length: TOTAL }, (_, i) => {
  // Midday, a minute apart within the day, so date order is entry order.
  const day = new Date(
    Date.UTC(2026, 9, 9, 12) - Math.floor(i / 3) * 86_400_000 - (i % 3) * 60_000,
  );
  const jarring = i % 2 === 0;
  const quart = i % 3 === 0;
  const qty = jarring ? 2 + (i % 7) : -1;
  return {
    id: `e${String(i + 1).padStart(3, "0")}`,
    date: day.toISOString(),
    type: jarring ? "jarring" : "jar_adjustment",
    description: `Entry ${i + 1}`,
    amountLbs: null,
    quantity: qty,
    totalAmount: null,
    notes: i === 0 ? "First of the season" : null,
    isReversal: false,
    reversesMovementId: null,
    cancelled: false,
    item: quart ? "Quart" : "Pint",
    itemKey: quart ? "jar:q1" : "jar:p1",
    itemCount: 1,
    varietal: jarring ? "Clover" : null,
    lotCode: jarring ? "LOT-1" : null,
    lotCount: jarring ? 1 : 0,
    fromLocation: "Honey house",
    toLocation: jarring ? "Honey house" : null,
    qty,
    qtyUnit: "jars",
  };
});

const FACETS = {
  items: [
    { value: "jar:p1", label: "Pint" },
    { value: "jar:q1", label: "Quart" },
  ],
  varietals: [{ value: "v1", label: "Clover" }],
  locations: [{ value: "l1", label: "Honey house" }],
};

function sortKey(entry: MockEntry, sort: string): string | number {
  switch (sort) {
    case "quantity":
      return entry.qty;
    case "type":
      return TYPE_LABEL[entry.type] ?? entry.type;
    case "item":
      return entry.item.toLowerCase();
    default:
      return entry.date;
  }
}

async function mockApp(page: Page, activityRequests: URL[] = []) {
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
          displayName: "Ledger test",
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Ledger test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/honey/activity/facets")) {
      return route.fulfill({ json: FACETS });
    }
    if (path.endsWith("/honey/activity")) {
      activityRequests.push(url);
      // The cursor is opaque to the client; the mock uses an offset.
      const offset = Number(url.searchParams.get("cursor") || "0");
      const limit = Number(url.searchParams.get("limit") || "50");
      const type = url.searchParams.get("type");
      const item = url.searchParams.get("item");
      const varietal = url.searchParams.get("varietal");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const sort = url.searchParams.get("sort") ?? "date";
      const dir = url.searchParams.get("dir") ?? (sort === "date" ? "desc" : "asc");
      const rows = ENTRIES.filter(
        (entry) =>
          (!type || type.split(",").includes(entry.type)) &&
          (!item || item.split(",").includes(entry.itemKey)) &&
          (!varietal || entry.varietal === "Clover") &&
          (!q || entry.description.toLowerCase().includes(q)),
      ).sort((a, b) => {
        const ka = sortKey(a, sort);
        const kb = sortKey(b, sort);
        const cmp = ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return dir === "desc" ? -cmp : cmp;
      });
      const slice = rows.slice(offset, offset + limit);
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return route.fulfill({ json: { entries: slice, nextCursor: next } });
    }
    return route.fulfill({ json: [] });
  });
}

const rows = (page: Page) => page.locator("tbody tr[data-grid-row]");
const row = (page: Page, index: number) => rows(page).nth(index);
const groupHeaders = (page: Page) =>
  page.locator("tbody tr:not([data-grid-row])");
/** Click a row on its Date cell (never on a link or the action button). */
const clickRow = (
  page: Page,
  index: number,
  modifiers?: ("Shift" | "ControlOrMeta")[],
) => row(page, index).locator("td").nth(1).click({ modifiers });
const header = (page: Page, name: string) =>
  page.getByRole("columnheader", { name, exact: false });

async function expectSelected(page: Page, indexes: number[]) {
  const all = rows(page);
  const count = await all.count();
  for (let i = 0; i < count; i += 1) {
    await expect(all.nth(i)).toHaveAttribute(
      "aria-selected",
      indexes.includes(i) ? "true" : "false",
    );
  }
}

async function scrollToEnd(page: Page) {
  await page.getByTestId("activity-load-more").scrollIntoViewIfNeeded();
}

test("Stock › Movements is in the Stock menu and Production › Activity redirects to it", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/serials");
  // Production keeps an Activity shortcut to the same page.
  await expect(
    page
      .getByRole("navigation", { name: "Production pages" })
      .getByRole("link", { name: "Activity", exact: true }),
  ).toHaveAttribute("href", "/stock/movements");

  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await mainNav.getByRole("link", { name: "Movements", exact: true }).click();
  await expect(page).toHaveURL(/\/stock\/movements$/);
  await expect(page.getByRole("heading", { name: "Movements", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/Movements/);
  await expect(rows(page)).toHaveCount(50);
  // The page sits in the Stock menu, and only Stock lights up for it.
  await expect(
    page
      .getByRole("navigation", { name: "Stock pages" })
      .getByRole("link", { name: "Movements", exact: true }),
  ).toBeVisible();
  await expect(mainNav.getByRole("link", { name: "Movements", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(mainNav.getByRole("link", { name: "Stock", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    mainNav.getByRole("link", { name: "Production", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");

  // The old route keeps working, query and all.
  await page.goto("/production/activity?type=jarring");
  await expect(page).toHaveURL(/\/stock\/movements\?type=jarring$/);
  await expect(page.getByRole("combobox", { name: "Filter by type" })).toHaveValue(
    "jarring",
  );
});

test("activity loads more pages as the end of the ledger scrolls into view", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/stock/movements");

  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByText("Entry 1", { exact: true })).toBeVisible();

  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(TOTAL);
  await expect(page.getByText(`End of ledger · ${TOTAL} entries`)).toBeVisible();

  // Each page asked for the next cursor, never the same one twice, in the
  // default order.
  const cursors = requests.map((url) => url.searchParams.get("cursor") ?? "");
  expect(cursors).toEqual(["", "50", "100"]);
  for (const url of requests) {
    expect(url.searchParams.get("sort")).toBe("date");
    expect(url.searchParams.get("dir")).toBe("desc");
  }
});

test("rows keep their colored type badges and show the ledger columns", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  for (const name of ["Date", "Type", "Entry", "Qty", "Item", "Lot", "Location", "Value", "Notes"]) {
    await expect(header(page, name).first()).toBeVisible();
  }

  const jarringBadge = row(page, 0).locator('[data-kind-icon="jarring"]').first();
  await expect(jarringBadge).toBeVisible();
  await expect(jarringBadge).toHaveClass(/bg-amber-500\/15/);
  await expect(jarringBadge.locator("svg")).toBeVisible();
  const adjustmentBadge = row(page, 1)
    .locator('[data-kind-icon="jar_adjustment"]')
    .first();
  await expect(adjustmentBadge).toBeVisible();
  await expect(adjustmentBadge).toHaveClass(/bg-slate-500\/15/);

  const first = row(page, 0);
  await expect(first).toContainText("Jarring");
  await expect(first).toContainText("+2 jars");
  await expect(first).toContainText("Quart");
  await expect(first).toContainText("Clover");
  await expect(first).toContainText("LOT-1");
  await expect(first).toContainText("Honey house");
  await expect(first).toContainText("First of the season");
  await expect(row(page, 1)).toContainText("−1 jar");

  // Every column fits a laptop-width window: no sideways scrollbar.
  const grid = page.locator("[data-grid-mode]").first();
  await expect(grid).toHaveAttribute("data-grid-mode", "table");
  expect(await grid.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("a header click sorts on the server, restarts paging and drops day groups", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);
  // Newest first, grouped by day.
  await expect(header(page, "Date")).toHaveAttribute("aria-sort", "descending");
  expect(await groupHeaders(page).count()).toBeGreaterThan(0);

  await header(page, "Qty").getByRole("button").click();
  await expect(page).toHaveURL(/sort=quantity/);
  const qtyDir = new URL(page.url()).searchParams.get("dir");
  expect(qtyDir === "asc" || qtyDir === "desc").toBe(true);
  await expect(header(page, "Qty")).toHaveAttribute(
    "aria-sort",
    qtyDir === "asc" ? "ascending" : "descending",
  );
  await expect(header(page, "Date")).not.toHaveAttribute("aria-sort", /.+/);
  const sortedRequest = requests.at(-1)!;
  expect(sortedRequest.searchParams.get("sort")).toBe("quantity");
  expect(sortedRequest.searchParams.get("dir")).toBe(qtyDir);
  // A new sort pages from the start.
  expect(sortedRequest.searchParams.get("cursor")).toBeNull();
  await expect(rows(page)).toHaveCount(50);
  await expect(groupHeaders(page)).toHaveCount(0);
  await expect(row(page, 0)).toContainText(qtyDir === "asc" ? "−1 jar" : "+8 jars");

  // Paging continues in that order.
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);
  const next = requests.at(-1)!;
  expect(next.searchParams.get("sort")).toBe("quantity");
  expect(next.searchParams.get("cursor")).toBe("50");

  // Clicking again flips the direction.
  await header(page, "Qty").getByRole("button").click();
  const flipped = qtyDir === "asc" ? "desc" : "asc";
  await expect(page).toHaveURL(new RegExp(`dir=${flipped}`));
  expect(requests.at(-1)!.searchParams.get("dir")).toBe(flipped);
  await expect(row(page, 0)).toContainText(flipped === "asc" ? "−1 jar" : "+8 jars");

  // Item sorts too.
  await header(page, "Item").getByRole("button").click();
  await expect(page).toHaveURL(/sort=item/);
  expect(requests.at(-1)!.searchParams.get("sort")).toBe("item");

  // Back to date (newest first, the default — a clean URL): day groups return.
  await header(page, "Date").getByRole("button").click();
  await expect(page).toHaveURL(/\/stock\/movements$/);
  await expect(header(page, "Date")).toHaveAttribute("aria-sort", "descending");
  // (The first page of that order may come from the query cache.)
  await expect(row(page, 0)).toContainText("Entry 1");
  expect(await groupHeaders(page).count()).toBeGreaterThan(0);

  // Oldest first is date ascending, still grouped by day.
  await header(page, "Date").getByRole("button").click();
  await expect(page).toHaveURL(/sort=date&dir=asc/);
  await expect(row(page, 0)).toContainText(`Entry ${TOTAL}`);
  expect(await groupHeaders(page).count()).toBeGreaterThan(0);

  // The sort survives a reload.
  const sortedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(sortedUrl);
  await expect(rows(page)).toHaveCount(50);
});

test("column filters and search are sent to the server and kept across pages", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  await page.getByRole("combobox", { name: "Filter by type" }).selectOption("jarring");
  await expect(page).toHaveURL(/type=jarring/);
  await expect(rows(page)).toHaveCount(50);
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(TOTAL / 2);
  await expect(page.getByText(`End of ledger · ${TOTAL / 2} entries`)).toBeVisible();
  const jarringPages = requests.filter(
    (url) => url.searchParams.get("type") === "jarring",
  );
  expect(jarringPages.map((url) => url.searchParams.get("cursor") ?? "")).toEqual([
    "",
    "50",
  ]);

  // Item choices come from the facets endpoint.
  await page.getByRole("combobox", { name: "Filter by item" }).selectOption({ label: "Quart" });
  await expect(page).toHaveURL(/item=jar%3Aq1|item=jar:q1/);
  // Jarrings (even i) that are quarts (i % 3 === 0): i % 6 === 0.
  await expect(rows(page)).toHaveCount(TOTAL / 6);
  expect(
    requests.some(
      (url) =>
        url.searchParams.get("item") === "jar:q1" &&
        url.searchParams.get("type") === "jarring",
    ),
  ).toBe(true);

  await page.getByRole("combobox", { name: "Filter by varietal" }).selectOption({ label: "Clover" });
  await expect(page).toHaveURL(/varietal=v1/);
  expect(requests.at(-1)!.searchParams.get("varietal")).toBe("v1");

  await page.getByRole("combobox", { name: "Filter by location" }).selectOption({ label: "Honey house" });
  await expect(page).toHaveURL(/location=l1/);
  expect(requests.at(-1)!.searchParams.get("location")).toBe("l1");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/type=|item=|varietal=|location=/);
  await expect(rows(page)).toHaveCount(50);

  await page.getByRole("combobox", { name: "Filter by type" }).selectOption("jarring");
  await page.getByRole("searchbox", { name: "Search movements" }).fill("Entry 11");
  await expect(page).toHaveURL(/q=Entry\+11|q=Entry%2011/);
  // The filter is picked and the search typed straight after it, before the
  // filter's navigation has necessarily landed: the search must merge onto
  // it, not overwrite it. "Entry 11" matches entries 11 and 110-119 (11 rows
  // unfiltered); entry n is index n-1 and jarrings are the even indexes, so
  // the jarring ones are 11, 111, 113, 115, 117 and 119.
  await expect(rows(page)).toHaveCount(6);
  expect(
    requests.some(
      (url) =>
        url.searchParams.get("q") === "Entry 11" &&
        url.searchParams.get("type") === "jarring",
    ),
  ).toBe(true);

  // Filters combine with a sort, and both survive a reload.
  await header(page, "Qty").getByRole("button").click();
  await expect(page).toHaveURL(/sort=quantity/);
  const last = requests.at(-1)!;
  expect(last.searchParams.get("type")).toBe("jarring");
  expect(last.searchParams.get("q")).toBe("Entry 11");
  await page.reload();
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByRole("combobox", { name: "Filter by type" })).toHaveValue("jarring");
  await expect(page.getByRole("searchbox", { name: "Search movements" })).toHaveValue(
    "Entry 11",
  );
});

test("a search typed while a filter's navigation is still in flight keeps the filter", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  // Hold every navigation's server payload, so the filter's URL change is
  // still pending when the debounced search writes its own.
  await page.route(
    (url) => url.searchParams.has("_rsc"),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    },
  );
  await page.getByRole("combobox", { name: "Filter by type" }).selectOption("jarring");
  await page.getByRole("searchbox", { name: "Search movements" }).fill("Entry 11");
  await expect(page).toHaveURL(/type=jarring/);
  await expect(page).toHaveURL(/q=Entry\+11|q=Entry%2011/);
  await expect(rows(page)).toHaveCount(6);
  // No request ever dropped the filter while carrying the search.
  expect(
    requests.filter(
      (url) => url.searchParams.get("q") === "Entry 11" && !url.searchParams.get("type"),
    ),
  ).toEqual([]);
});

test("click, shift-click and ctrl-click follow desktop selection conventions", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  await clickRow(page, 1);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();

  // Shift-click: the contiguous range from the anchor.
  await clickRow(page, 5, ["Shift"]);
  await expect(page.getByText("5 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [1, 2, 3, 4, 5]);

  // Shift-click again re-ranges from the same anchor.
  await clickRow(page, 3, ["Shift"]);
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [1, 2, 3]);

  // Ctrl/Cmd-click toggles one row without touching the rest.
  await clickRow(page, 8, ["ControlOrMeta"]);
  await expect(page.getByText("4 selected", { exact: true })).toBeVisible();
  await clickRow(page, 2, ["ControlOrMeta"]);
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [1, 3, 8]);

  // A plain click collapses to one row and resets the anchor there.
  await clickRow(page, 10);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await clickRow(page, 12, ["Shift"]);
  await expectSelected(page, [10, 11, 12]);

  // The checkbox toggles instead of collapsing.
  await row(page, 20).getByRole("checkbox").click();
  await expect(page.getByText("4 selected", { exact: true })).toBeVisible();

  // Escape clears.
  await page.keyboard.press("Escape");
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
  await expectSelected(page, []);
});

test("a shift-click range follows the on-screen sorted order", async ({ page }) => {
  await mockApp(page);
  await page.goto("/stock/movements?sort=quantity&dir=asc");
  await expect(rows(page)).toHaveCount(50);

  await clickRow(page, 2);
  await clickRow(page, 6, ["Shift"]);
  await expect(page.getByText("5 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [2, 3, 4, 5, 6]);

  // Re-sorting reorders the rows, so the selection is dropped.
  await header(page, "Qty").getByRole("button").click();
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
});

test("a shift-click range spans loaded pages and survives loading more", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  await clickRow(page, 45);
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);

  await clickRow(page, 55, ["Shift"]);
  await expect(page.getByText("11 selected", { exact: true })).toBeVisible();
  await expect(row(page, 45)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, 55)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, 56)).toHaveAttribute("aria-selected", "false");

  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(TOTAL);
  await expect(page.getByText("11 selected", { exact: true })).toBeVisible();
});

test("shift+arrow extends from the keyboard and select all says it means loaded rows", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  await clickRow(page, 2);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [2, 3, 4]);
  await page.keyboard.press("Shift+ArrowUp");
  await expectSelected(page, [2, 3]);
  await page.keyboard.press("Escape");

  await page.getByRole("checkbox", { name: "Select all loaded movement rows" }).click();
  await expect(page.getByText("50 loaded rows selected", { exact: true })).toBeVisible();

  // Rows loaded afterwards are not silently added to the selection.
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);
  await expect(page.getByText("50 selected", { exact: true })).toBeVisible();
  await expect(row(page, 60)).toHaveAttribute("aria-selected", "false");
});

test("reversing one row asks first and posts only after confirming", async ({
  page,
}) => {
  const reversals: string[] = [];
  await mockApp(page);
  await page.route("**/api/v1/honey/**", async (route) => {
    const method = route.request().method();
    if (method !== "GET") {
      reversals.push(`${method} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ json: {} });
    }
    return route.fallback();
  });
  await page.goto("/stock/movements");
  await expect(rows(page)).toHaveCount(50);

  await row(page, 0).getByRole("button", { name: "Reverse jarring entry" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Reverse this entry?");
  await dialog.getByRole("button", { name: "Keep as is" }).click();
  await expect(dialog).toHaveCount(0);
  expect(reversals).toEqual([]);

  await row(page, 0).getByRole("button", { name: "Reverse jarring entry" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reverse" }).click();
  await expect.poll(() => reversals.length).toBeGreaterThan(0);
});

test("on a phone the ledger is cards that select by tap and checkbox, with select all above them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page);
  await page.goto("/stock/movements");

  const list = page.getByRole("list", { name: "Stock movements" });
  await expect(list).toBeVisible();
  await expect(page.getByRole("table", { name: "Stock movements" })).toHaveCount(0);
  const cards = list.locator("[data-grid-card]");
  await expect(cards).toHaveCount(50);

  // Card title: the colored type badge and the entry.
  const firstCard = cards.nth(0);
  const badge = firstCard.locator('[data-kind-icon="jarring"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/bg-amber-500\/15/);
  await expect(firstCard).toContainText("Entry 1");
  // Fields: qty, item, lot, location.
  for (const label of ["Qty", "Item", "Lot", "Location"]) {
    await expect(firstCard.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(firstCard).toContainText("+2 jars");
  await expect(firstCard).toContainText("Clover");
  // Reverse is the card's action.
  await expect(
    firstCard.getByRole("button", { name: "Reverse jarring entry" }),
  ).toBeVisible();

  // Sorting on a phone uses the grid's select, still on the server.
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("qty:desc");
  await expect(page).toHaveURL(/sort=quantity&dir=desc/);
  await expect(cards.nth(0)).toContainText("+8 jars");
  await page.getByRole("combobox", { name: "Sort by" }).selectOption("");
  await expect(page).not.toHaveURL(/sort=/);
  await expect(cards.nth(0)).toContainText("Entry 1");

  /** Tap a card on its Qty label (never on a link or the action button). */
  const tapCard = (index: number) =>
    cards.nth(index).getByText("Qty", { exact: true }).click();

  // A tap selects one card, like a row click.
  await tapCard(1);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(cards.nth(1)).toHaveAttribute("data-state", "selected");
  await expect(cards.nth(1).getByRole("checkbox")).toHaveAttribute("data-state", "checked");

  // A card's checkbox adds to the selection instead of replacing it.
  await cards.nth(4).getByRole("checkbox").click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(cards.nth(1)).toHaveAttribute("data-state", "selected");
  await expect(cards.nth(4)).toHaveAttribute("data-state", "selected");
  await expect(cards.nth(2)).not.toHaveAttribute("data-state", "selected");

  // A plain tap elsewhere collapses to that card.
  await tapCard(6);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(cards.nth(4)).not.toHaveAttribute("data-state", "selected");

  // Cards have no header row: select all sits above them.
  await page.getByRole("checkbox", { name: "Select all loaded movement rows" }).click();
  await expect(page.getByText("50 loaded rows selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
});
