import { expect, test, type Page } from "@playwright/test";

// Sales › Expenses › Categorize: what the Folio history import brought in, as
// a selectable DataGrid with bulk categorizing. Every /api/v1 call is mocked
// to the API's shapes (GET /folio-imports, PUT /folio-imports/category, the
// sale linker's routes); the mock applies writes so refetches show them. One
// dev server: keep these serial.
test.describe.configure({ mode: "serial" });

interface MockItem {
  id: string;
  bookId: string;
  bookLabel: string;
  bookRetired: boolean;
  transactionGuid: string;
  direction: "expense" | "income";
  entityId: string;
  date: string;
  description: string;
  notes: string | null;
  amount: number;
  category: string;
  saleId: string | null;
  saleSummary: string | null;
  state: "remote_changed" | "remote_deleted" | "unrepresentable" | null;
  message: string | null;
  pending: unknown;
  deleted: boolean;
}

const BOOK = "b0000000-0000-4000-8000-000000000001";
const SALE = "5a1e0000-0000-4000-8000-000000000001";

function item(
  id: string,
  direction: "expense" | "income",
  date: string,
  description: string,
  amount: number,
  extra: Partial<MockItem> = {},
): MockItem {
  return {
    id,
    bookId: BOOK,
    bookLabel: "Beekeeping",
    bookRetired: false,
    transactionGuid: `guid-${id}`,
    direction,
    entityId: `entity-${id}`,
    date: `${date}T00:00:00Z`,
    description,
    notes: null,
    amount,
    category: "uncategorized",
    saleId: null,
    saleSummary: null,
    state: null,
    message: null,
    pending: null,
    deleted: false,
    ...extra,
  };
}

/**
 * Newest first in the default "Needs attention" view:
 * Market deposit, Customer paid back, Mann Lake frames, Sugar,
 * Frames returned, Wax (changed in Folio), Duplicate entry (deleted in Folio).
 */
function seed(): MockItem[] {
  return [
    item("e1", "expense", "2024-03-05", "Mann Lake frames", 129.99),
    item("e2", "expense", "2024-03-04", "Sugar", 20),
    item("e3", "expense", "2024-03-03", "Frames returned", -12),
    item("c1", "expense", "2024-03-02", "Wax", 7, {
      category: "packaging",
      state: "remote_changed",
      message: "Changed in Folio after you categorized it",
      pending: {
        direction: "expense",
        amountCents: 900,
        postDate: "2024-03-02",
        description: "Wax",
        memo: "",
        accountGuids: [],
      },
    }),
    item("d1", "expense", "2024-03-01", "Duplicate entry", 5, {
      state: "remote_deleted",
      message: "Deleted in Folio",
    }),
    item("i1", "income", "2024-06-10", "Market deposit", 45),
    item("i2", "income", "2024-06-09", "Customer paid back", -5),
    item("e4", "expense", "2024-02-01", "Syrup", 30, { category: "feed" }),
    item("i3", "income", "2024-01-15", "Farm stand", 15, { category: "honey_sales" }),
  ];
}

const EXPENSE_CATEGORIES = [
  "bees_queens", "feed", "treatments", "packaging", "equipment", "mileage",
  "market_fees", "labor", "other", "grocery",
];
const INCOME_CATEGORIES = [
  "uncategorized", "sales_deposit", "honey_sales", "colony_sales",
  "product_sales", "pollination", "services", "grant", "other",
];

function needsAttention(entry: MockItem): boolean {
  return !entry.deleted && (entry.category === "uncategorized" || entry.state != null);
}

interface Written {
  method: string;
  path: string;
  body: unknown;
}

async function mockApp(page: Page, written: Written[] = []) {
  const items = seed();
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
          displayName: "Categorize test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Categorize test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      written.push({ method: request.method(), path, body });
      if (path.endsWith("/folio-imports/category")) {
        for (const entry of items) {
          if (body.ids.includes(entry.id)) entry.category = body.category;
        }
        return route.fulfill({ json: { success: true, updated: body.ids.length } });
      }
      if (path.endsWith("/folio-imports/keep")) {
        for (const entry of items) {
          if (body.ids.includes(entry.id)) {
            entry.state = null;
            entry.message = null;
            entry.pending = null;
          }
        }
        return route.fulfill({ json: { success: true, updated: body.ids.length } });
      }
      const sale = path.match(/\/folio-imports\/([^/]+)\/sale$/);
      if (sale) {
        const entry = items.find((candidate) => candidate.id === sale[1]);
        if (entry) {
          entry.saleId = body.saleId;
          entry.saleSummary = body.saleId ? "S-1001 — Jane Doe" : null;
          if (entry.category === "uncategorized") entry.category = "sales_deposit";
        }
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith("/sale-candidates")) {
      return route.fulfill({
        json: {
          sales: [
            {
              id: SALE,
              date: "2024-06-08T00:00:00Z",
              orderNumber: "S-1001",
              customerName: "Jane Doe",
              total: 45,
              amountPaid: 45,
            },
          ],
        },
      });
    }
    if (path.endsWith("/folio-imports")) {
      const view = url.searchParams.get("view") ?? "attention";
      const listed = view === "all" ? items : items.filter(needsAttention);
      const live = items.filter((entry) => !entry.deleted);
      return route.fulfill({
        json: {
          items: listed,
          total: listed.length,
          counts: {
            imported: live.length,
            toCategorize: live.filter((entry) => entry.category === "uncategorized").length,
            expensesToCategorize: live.filter(
              (entry) => entry.direction === "expense" && entry.category === "uncategorized",
            ).length,
            incomeToCategorize: live.filter(
              (entry) => entry.direction === "income" && entry.category === "uncategorized",
            ).length,
            conflicts: items.filter((entry) => entry.state != null).length,
            unlinkedIncome: 2,
            unlinkedIncomeAmount: 60,
          },
          expenseCategories: EXPENSE_CATEGORIES,
          otherIncomeCategories: INCOME_CATEGORIES,
        },
      });
    }
    if (path.endsWith("/expenses")) {
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: [] });
  });
}

const grid = (page: Page) => page.getByRole("table", { name: "Imported entries" });
const rows = (page: Page) => grid(page).locator("tbody tr[data-grid-row]");
const rowNamed = (page: Page, text: string) => rows(page).filter({ hasText: text });
/** Click a row on its Date cell (never on a picker or a button). */
const clickRow = (page: Page, text: string, modifiers?: ("Shift" | "ControlOrMeta")[]) =>
  rowNamed(page, text).locator("td").nth(1).click({ modifiers });
const bulkBar = (page: Page) => page.getByRole("region", { name: "Bulk actions" });

test("the From Folio card on Expenses links to the Categorize page, also in the Sales menu", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/sales/expenses");
  const link = page.getByRole("link", { name: "Categorize 7 entries" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/sales\/expenses\/categorize$/);
  await expect(page.getByRole("heading", { name: "Categorize", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Categorize" }).first(),
  ).toBeAttached();
});

test("rows show direction badges, signed amounts and status; the status filter lives in the URL", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/sales/expenses/categorize");

  // Needs attention by default: uncategorized and conflicts, newest first.
  await expect(rows(page)).toHaveCount(7);
  await expect(rows(page).nth(0)).toContainText("Market deposit");
  await expect(rows(page).nth(6)).toContainText("Duplicate entry");

  const refund = rowNamed(page, "Frames returned");
  await expect(refund.locator('[data-direction="refund"]')).toHaveText("Refund");
  await expect(refund).toContainText("−$12.00 refund");
  await expect(rowNamed(page, "Sugar").locator('[data-direction="expense"]')).toHaveText("Expense");
  await expect(rowNamed(page, "Market deposit").locator('[data-direction="income"]')).toHaveText("Income");
  await expect(rowNamed(page, "Wax").locator('[data-status="changed"]')).toHaveText("Changed in Folio");
  await expect(rowNamed(page, "Duplicate entry").locator('[data-status="deleted"]')).toHaveText("Deleted in Folio");
  // An entry deleted in Folio cannot be categorized until it is settled.
  await expect(
    page.getByRole("combobox", { name: "Category for Duplicate entry" }),
  ).toBeDisabled();

  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("categorized");
  await expect(page).toHaveURL(/status=categorized/);
  await expect(rows(page)).toHaveCount(2);
  await expect(rowNamed(page, "Syrup")).toHaveCount(1);
  await expect(rowNamed(page, "Farm stand")).toHaveCount(1);

  // Reloading keeps the filter; the direction filter narrows further.
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("combobox", { name: "Filter by direction" }).selectOption("income");
  await expect(page).toHaveURL(/direction=income/);
  await expect(page).toHaveURL(/status=categorized/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).nth(0)).toContainText("Farm stand");

  // Deposits not linked to a sale (the profitability report's link).
  await page.goto("/sales/expenses/categorize?status=unlinked");
  await expect(rows(page)).toHaveCount(2);
  await expect(rowNamed(page, "Market deposit")).toHaveCount(1);
  await expect(rowNamed(page, "Farm stand")).toHaveCount(1);

  // Search matches descriptions.
  await page.goto("/sales/expenses/categorize?status=all");
  await page.getByRole("searchbox", { name: "Search imported entries" }).fill("frames");
  await expect(page).toHaveURL(/q=frames/);
  await expect(rows(page)).toHaveCount(2);
});

test("shift-click selects a range and the bulk bar sets one category on all of it", async ({
  page,
}) => {
  const written: Written[] = [];
  await mockApp(page, written);
  await page.goto("/sales/expenses/categorize");
  await expect(rows(page)).toHaveCount(7);

  // Mann Lake frames → Frames returned: two expenses and a refund.
  await clickRow(page, "Mann Lake frames");
  await clickRow(page, "Frames returned", ["Shift"]);
  await expect(bulkBar(page)).toContainText("3 selected");
  for (const name of ["Mann Lake frames", "Sugar", "Frames returned"]) {
    await expect(rowNamed(page, name)).toHaveAttribute("aria-selected", "true");
  }
  await expect(rowNamed(page, "Wax")).toHaveAttribute("aria-selected", "false");

  // Expenses and refunds: expense categories only.
  await bulkBar(page).getByRole("combobox", { name: "Set category for selected" }).click();
  await expect(page.getByRole("option", { name: "Pollination" })).toHaveCount(0);
  await page.getByRole("option", { name: "Feed" }).click();

  await expect(page.getByText("Categorized 3 entries as Feed")).toBeVisible();
  const put = written.find((entry) => entry.path.endsWith("/folio-imports/category"));
  expect(put?.method).toBe("PUT");
  expect(put?.body).toEqual({ ids: ["e1", "e2", "e3"], category: "feed" });

  // The categorized rows leave "Needs attention" and the selection is gone.
  await expect(rows(page)).toHaveCount(4);
  await expect(bulkBar(page)).toHaveCount(0);
  await expect(rowNamed(page, "Sugar")).toHaveCount(0);
});

test("a mixed selection cannot share a category; selected conflicts can be kept in bulk", async ({
  page,
}) => {
  const written: Written[] = [];
  await mockApp(page, written);
  await page.goto("/sales/expenses/categorize");
  await expect(rows(page)).toHaveCount(7);

  await clickRow(page, "Market deposit");
  await clickRow(page, "Sugar", ["Shift"]);
  await expect(bulkBar(page)).toContainText("4 selected");
  await expect(bulkBar(page)).toContainText("Select only expenses or only income");
  await expect(
    bulkBar(page).getByRole("combobox", { name: "Set category for selected" }),
  ).toHaveCount(0);

  // Wax (changed) and Duplicate entry (deleted): keep the Atlas versions.
  await clickRow(page, "Wax");
  await clickRow(page, "Duplicate entry", ["Shift"]);
  await expect(bulkBar(page)).toContainText("2 selected");
  await bulkBar(page).getByRole("button", { name: "Keep Atlas version (2)" }).click();
  await expect(page.getByText("Kept the Atlas version of 2 entries")).toBeVisible();
  const keep = written.find((entry) => entry.path.endsWith("/folio-imports/keep"));
  expect(keep?.body).toEqual({ ids: ["c1", "d1"] });
});

test("an income row links to a sale from its Sale cell; expense rows explain why they cannot", async ({
  page,
}) => {
  const written: Written[] = [];
  await mockApp(page, written);
  await page.goto("/sales/expenses/categorize");
  await expect(rows(page)).toHaveCount(7);

  await expect(
    rowNamed(page, "Sugar").getByRole("button", { name: /Only income can be linked to a sale/ }),
  ).toBeDisabled();
  await expect(
    rowNamed(page, "Customer paid back").getByRole("button", { name: /paid back can't be/ }),
  ).toBeDisabled();

  await rowNamed(page, "Market deposit")
    .getByRole("button", { name: "Link Market deposit to a sale" })
    .click();
  // Opening the linker does not select the row.
  await expect(bulkBar(page)).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "Link to a sale" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /S-1001 — Jane Doe/ }).click();
  await expect(page.getByText("Linked to the sale")).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const link = written.find((entry) => entry.path.endsWith("/folio-imports/i1/sale"));
  expect(link?.method).toBe("PUT");
  expect(link?.body).toEqual({ saleId: SALE });
  // Linked and now a sales deposit, it no longer needs attention.
  await expect(rowNamed(page, "Market deposit")).toHaveCount(0);
});

test("on a phone the entries are cards that select by tap, with the pickers on each card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const written: Written[] = [];
  await mockApp(page, written);
  await page.goto("/sales/expenses/categorize");

  const list = page.getByRole("list", { name: "Imported entries" });
  await expect(list).toBeVisible();
  await expect(grid(page)).toHaveCount(0);
  const cards = list.locator("[data-grid-card]");
  await expect(cards).toHaveCount(7);

  const deposit = cards.filter({ hasText: "Market deposit" });
  await expect(deposit.locator('[data-direction="income"]')).toBeVisible();
  await expect(deposit.getByRole("combobox", { name: "Category for Market deposit" })).toBeVisible();
  await expect(deposit.getByRole("button", { name: "Link Market deposit to a sale" })).toBeVisible();

  // A tap on a card's Amount label selects it; a checkbox adds another.
  const tap = (text: string) =>
    cards.filter({ hasText: text }).getByText("Amount", { exact: true }).click();
  await tap("Mann Lake frames");
  await expect(bulkBar(page)).toContainText("1 selected");
  await cards.filter({ hasText: "Sugar" }).getByRole("checkbox").click();
  await expect(bulkBar(page)).toContainText("2 selected");

  await bulkBar(page).getByRole("combobox", { name: "Set category for selected" }).click();
  await page.getByRole("option", { name: "Equipment" }).click();
  await expect(page.getByText("Categorized 2 entries as Equipment")).toBeVisible();
  const put = written.find((entry) => entry.path.endsWith("/folio-imports/category"));
  expect(put?.body).toEqual({ ids: ["e1", "e2"], category: "equipment" });
  await expect(cards).toHaveCount(5);
});
