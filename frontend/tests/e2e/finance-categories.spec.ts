import { expect, test, type Page } from "@playwright/test";

// Expense and income categories are the operator's own list
// (/finance-categories), edited once in Operation setup and read everywhere
// a category is shown or chosen. Every /api/v1 call is mocked to the API's
// shapes; the mock applies writes so refetches show them. One dev server:
// keep these serial.
test.describe.configure({ mode: "serial" });

interface Category {
  id: string;
  kind: "expense" | "income";
  key: string;
  label: string;
  sortOrder: number;
  archived: boolean;
  archivedAt: string | null;
  isSystem: boolean;
  usageCount: number;
  deletable: boolean;
}

function category(
  kind: Category["kind"],
  key: string,
  label: string,
  sortOrder: number,
  extra: Partial<Category> = {},
): Category {
  return {
    id: `${kind}-${key}`,
    kind,
    key,
    label,
    sortOrder,
    archived: false,
    archivedAt: null,
    isSystem: false,
    usageCount: 0,
    deletable: true,
    ...extra,
  };
}

function seed(): Category[] {
  return [
    category("expense", "uncategorized", "Uncategorized", 0, { isSystem: true, deletable: false }),
    category("expense", "bees_queens", "Bees and queens", 10, { isSystem: true, deletable: false }),
    category("expense", "feed", "Feed", 20, { usageCount: 3, deletable: false }),
    category("expense", "packaging", "Packaging", 40),
    category("expense", "fuel", "Truck fuel", 110, { usageCount: 1, deletable: false }),
    category("expense", "candles", "Candles", 120, {
      archived: true,
      archivedAt: "2026-09-01T00:00:00Z",
      usageCount: 2,
      deletable: false,
    }),
    category("income", "uncategorized", "Uncategorized", 0, { isSystem: true, deletable: false }),
    category("income", "sales_deposit", "Sales deposit", 10, { isSystem: true, deletable: false }),
    category("income", "honey_sales", "Honey sales", 20),
    category("income", "tours", "Apiary tours", 90, { usageCount: 1, deletable: false }),
  ];
}

const BOOK = "b0000000-0000-4000-8000-000000000001";

function importItem(id: string, direction: "expense" | "income", description: string, category: string) {
  return {
    id,
    bookId: BOOK,
    bookLabel: "Beekeeping",
    bookRetired: false,
    transactionGuid: `guid-${id}`,
    direction,
    entityId: `entity-${id}`,
    date: "2026-03-05T00:00:00Z",
    description,
    notes: null,
    amount: 25,
    category,
    saleId: null,
    saleSummary: null,
    state: null,
    message: null,
    pending: null,
    deleted: false,
  };
}

function expense(id: string, category: string, description: string, amount: number) {
  return {
    id,
    expenseDate: `${new Date().getFullYear()}-03-05T00:00:00Z`,
    category,
    description,
    amount,
    apiaryId: null,
    apiaryName: null,
    hiveId: null,
    hiveName: null,
    harvestLotId: null,
    lotCode: null,
    season: null,
    vendor: null,
    quantity: null,
    unit: null,
    notes: null,
    source: "atlas",
    folioImportId: null,
    folioState: null,
  };
}

interface Written {
  method: string;
  path: string;
  body: unknown;
}

interface MockOptions {
  written?: Written[];
  /** Leave /finance-categories to the catch-all [] (an older or failing API). */
  noCategories?: boolean;
  expenses?: ReturnType<typeof expense>[];
}

async function mockApp(page: Page, options: MockOptions = {}) {
  const written = options.written ?? [];
  const categories = seed();
  const expenses = options.expenses ?? [expense("x1", "fuel", "Diesel", 42)];
  const ordered = (kind: string) =>
    categories.filter((row) => row.kind === kind).sort((a, b) => a.sortOrder - b.sortOrder);
  const items = [
    importItem("e1", "expense", "Mann Lake frames", "uncategorized"),
    importItem("e2", "expense", "Gas station", "fuel"),
    importItem("i1", "income", "Tour group", "tours"),
  ];

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
          displayName: "Categories test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Categories test",
          email: null,
          isAdmin: true,
          hasPassword: true,
          memberships: [],
        },
      });
    }

    if (request.method() !== "GET") {
      const body = request.method() === "DELETE" ? null : request.postDataJSON();
      written.push({ method: request.method(), path, body });
      if (path.endsWith("/finance-categories") && request.method() === "POST") {
        const key = String(body.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const max = Math.max(...ordered(body.kind).map((row) => row.sortOrder));
        const created = category(body.kind, key, body.label, max + 10);
        categories.push(created);
        return route.fulfill({ status: 201, json: created });
      }
      if (path.endsWith("/finance-categories/order")) {
        (body.ids as string[]).forEach((id, index) => {
          const row = categories.find((candidate) => candidate.id === id);
          if (row) row.sortOrder = (index + 1) * 10;
        });
        return route.fulfill({ json: { success: true } });
      }
      const one = path.match(/\/finance-categories\/([^/]+)$/);
      if (one) {
        const index = categories.findIndex((row) => row.id === one[1]);
        if (request.method() === "DELETE") {
          categories.splice(index, 1);
          return route.fulfill({ json: { success: true, deleted: true } });
        }
        const row = categories[index];
        if (typeof body.label === "string") row.label = body.label;
        if (typeof body.archived === "boolean") row.archived = body.archived;
        return route.fulfill({ json: { success: true } });
      }
      if (path.endsWith("/expenses")) {
        expenses.unshift(expense("x-new", body.category, body.description, body.amount));
        return route.fulfill({ status: 201, json: { id: "x-new" } });
      }
      return route.fulfill({ json: { success: true } });
    }

    if (path.endsWith("/finance-categories") && !options.noCategories) {
      return route.fulfill({ json: ordered(url.searchParams.get("kind") ?? "expense") });
    }
    if (path.endsWith("/expenses")) {
      return route.fulfill({ json: expenses });
    }
    if (path.endsWith("/folio-imports")) {
      const active = (kind: string) =>
        ordered(kind)
          .filter((row) => !row.archived)
          .map((row) => row.key);
      return route.fulfill({
        json: {
          items,
          total: items.length,
          counts: {
            imported: items.length,
            toCategorize: 1,
            expensesToCategorize: 1,
            incomeToCategorize: 0,
            conflicts: 0,
            unlinkedIncome: 0,
            unlinkedIncomeAmount: 0,
          },
          expenseCategories: active("expense").filter((key) => key !== "uncategorized"),
          otherIncomeCategories: active("income"),
        },
      });
    }
    if (path.endsWith("/admin/policy")) {
      return route.fulfill({
        json: {
          laborTrackingEnabled: false,
          miteThresholdPer100: null,
          miteThresholdPerDay: null,
          miteCheckIntervalDays: null,
          moistureThresholdPct: null,
          ntfy: { serverUrl: "", topic: "", hasAccessToken: false, enabled: false, eventKinds: [] },
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  return written;
}

const expenseList = (page: Page) => page.getByRole("list", { name: "Expense categories" });
const expenseSection = (page: Page) => page.getByRole("region", { name: "Expense categories" });

test("Operation setup edits both category lists", async ({ page }) => {
  const written = await mockApp(page);
  await page.goto("/admin/setup#finance-categories");

  const editor = page.locator('[data-config-editor="finance-categories"]');
  await expect(editor).toBeVisible();
  await expect(expenseList(page).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByRole("list", { name: "Income categories" }).getByRole("listitem")).toHaveCount(4);

  // Labels, usage, built-in and archived markers.
  const fuel = expenseList(page).getByRole("listitem", { name: "Truck fuel" });
  await expect(fuel).toContainText("1 entry");
  const uncategorized = expenseList(page).getByRole("listitem", { name: "Uncategorized" });
  await expect(uncategorized).toContainText("Built in");
  await expect(expenseList(page).getByRole("listitem", { name: "Candles" })).toContainText("Archived");
  // A built-in category can be renamed but never archived or deleted; a used
  // one cannot be deleted.
  await expect(uncategorized.getByRole("button", { name: "Rename Uncategorized" })).toBeVisible();
  await expect(uncategorized.getByRole("button", { name: /^Archive / })).toHaveCount(0);
  await expect(uncategorized.getByRole("button", { name: /^Delete / })).toHaveCount(0);
  await expect(fuel.getByRole("button", { name: "Delete Truck fuel" })).toHaveCount(0);

  // Add.
  await expenseSection(page).getByLabel("New expense category name").fill("Wax supplies");
  await expenseSection(page).getByRole("button", { name: "Add" }).click();
  await expect(expenseList(page).getByRole("listitem", { name: "Wax supplies" })).toBeVisible();
  expect(written).toContainEqual({
    method: "POST",
    path: "/api/v1/finance-categories",
    body: { kind: "expense", label: "Wax supplies" },
  });

  // Rename inline.
  await fuel.getByRole("button", { name: "Rename Truck fuel" }).click();
  const name = expenseList(page).getByLabel("Name for Truck fuel");
  await name.fill("Fuel");
  await name.press("Enter");
  await expect(expenseList(page).getByRole("listitem", { name: "Fuel", exact: true })).toBeVisible();
  expect(written).toContainEqual({
    method: "PATCH",
    path: "/api/v1/finance-categories/expense-fuel",
    body: { label: "Fuel" },
  });

  // Archive and unarchive.
  await expenseList(page).getByRole("button", { name: "Archive Packaging" }).click();
  await expect(expenseList(page).getByRole("button", { name: "Unarchive Packaging" })).toBeVisible();
  expect(written).toContainEqual({
    method: "PATCH",
    path: "/api/v1/finance-categories/expense-packaging",
    body: { archived: true },
  });

  // Delete one nothing uses, after a confirmation step.
  const wax = expenseList(page).getByRole("listitem", { name: "Wax supplies" });
  await wax.getByRole("button", { name: "Delete Wax supplies" }).click();
  await wax.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(wax).toHaveCount(0);
  expect(written.some((write) => write.method === "DELETE" && write.path.endsWith("/finance-categories/expense-wax_supplies"))).toBe(true);

  // Reorder: Feed moves above Bees and queens.
  await expenseList(page).getByRole("button", { name: "Move Feed up" }).click();
  await expect(expenseList(page).getByRole("listitem").nth(1)).toHaveAccessibleName("Feed");
  const order = written.find((write) => write.path.endsWith("/finance-categories/order"));
  expect(order?.body).toEqual({
    kind: "expense",
    ids: ["expense-uncategorized", "expense-feed", "expense-bees_queens", "expense-packaging", "expense-fuel", "expense-candles"],
  });
});

test("the expense form offers the active categories by label and links to manage them", async ({ page }) => {
  const written = await mockApp(page);
  await page.goto("/sales/expenses");

  // The table shows the operator's label for a category it added.
  const table = page.getByRole("table", { name: "Expenses" });
  await expect(table.getByRole("row").filter({ hasText: "Diesel" })).toContainText("Truck fuel");

  await page.getByRole("button", { name: "Add expense" }).click();
  const dialog = page.getByRole("dialog", { name: "Add expense" });
  await expect(dialog.getByRole("link", { name: "Manage categories" })).toHaveAttribute(
    "href",
    "/admin/setup#finance-categories",
  );
  await dialog.getByRole("combobox", { name: "Category" }).click();
  const options = page.getByRole("option");
  await expect(options.filter({ hasText: "Truck fuel" })).toHaveCount(1);
  await expect(options.filter({ hasText: "Feed" })).toHaveCount(1);
  // Archived categories and the import-only "Uncategorized" are not offered.
  await expect(options.filter({ hasText: "Candles" })).toHaveCount(0);
  await expect(options.filter({ hasText: "Uncategorized" })).toHaveCount(0);
  await page.getByRole("option", { name: "Truck fuel" }).click();

  // Date, Description, Amount are the first three textboxes.
  await dialog.getByRole("textbox").nth(1).fill("Gas can");
  await dialog.getByRole("textbox").nth(2).fill("18");
  await dialog.getByRole("button", { name: "Save expense" }).click();
  await expect(dialog).toBeHidden();
  const saved = written.find((write) => write.method === "POST" && write.path.endsWith("/expenses"));
  expect(saved?.body).toMatchObject({ category: "fuel", description: "Gas can", amount: 18 });
});

test("the Categorize page shows the operator's labels and offers new categories", async ({ page }) => {
  const written = await mockApp(page);
  await page.goto("/sales/expenses/categorize?status=all");

  await expect(page.getByRole("link", { name: "Manage categories" })).toHaveAttribute(
    "href",
    "/admin/setup#finance-categories",
  );
  const grid = page.getByRole("table", { name: "Imported entries" });
  await expect(grid.getByRole("combobox", { name: "Category for Gas station" })).toHaveText("Truck fuel");
  await expect(grid.getByRole("combobox", { name: "Category for Tour group" })).toHaveText("Apiary tours");

  await grid.getByRole("combobox", { name: "Category for Mann Lake frames" }).click();
  await expect(page.getByRole("option", { name: "Truck fuel" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Candles" })).toHaveCount(0);
  await page.getByRole("option", { name: "Truck fuel" }).click();
  await expect(page.getByText("Categorized as Truck fuel")).toBeVisible();
  expect(written).toContainEqual({
    method: "PUT",
    path: "/api/v1/folio-imports/e1/category",
    body: { category: "fuel" },
  });
});

test("without a category list the built-in labels and a humanized fallback are shown", async ({ page }) => {
  await mockApp(page, {
    noCategories: true,
    expenses: [
      expense("x1", "bees_queens", "Package bees", 160),
      expense("x2", "trailer_rental", "Trailer", 40),
    ],
  });
  await page.goto("/sales/expenses");
  const table = page.getByRole("table", { name: "Expenses" });
  await expect(table.getByRole("row").filter({ hasText: "Package bees" })).toContainText("Bees and queens");
  await expect(table.getByRole("row").filter({ hasText: "Trailer" })).toContainText("Trailer rental");
});
