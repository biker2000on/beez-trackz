import { expect, test, type Page } from "@playwright/test";

/**
 * Orders & register (/sales) lists jars that left at $0 — given away or kept
 * for own use — beside the sales, newest first, from GET /sales/register.
 * A give-away recorded from the page shows up straight away (it used to
 * vanish into the inventory ledger), a filter in the URL narrows the rows,
 * and a give-away can be undone (DELETE /honey/movements/{id}).
 *
 * Every `/api/v1/**` call is `page.route`-mocked to the API's shapes (see
 * form-availability.spec.ts). The register mock is stateful: a POSTed
 * give-away becomes a row and a DELETE marks it reversed, the way the server
 * does.
 */

test.describe.configure({ mode: "serial" });

const HOME = "99999999-0000-4000-8000-000000000000";
const LOT_CLOVER = "bbbbbbbb-2222-2222-2222-222222222222";
const JAR_PINT = "dddddddd-4444-4444-4444-444444444444";
const SALE = "a1a1a1a1-1111-4111-8111-111111111111";
const GIFT = "a3a3a3a3-3333-4333-8333-333333333333";
const OWN_USE = "a4a4a4a4-4444-4444-8444-444444444444";
const AS_OF = "2026-09-03T12:00:00Z";

function sale() {
  return {
    id: SALE,
    date: "2026-09-02T00:00:00Z",
    customerId: null,
    harvestLotId: null,
    harvestLotCode: null,
    customerName: "Ann Buyer",
    location: "Farm stand",
    stockLocationId: null,
    channel: "direct",
    paymentMethod: "cash",
    totalAmount: 24,
    discountAmount: 0,
    amountPaid: 24,
    tax: null,
    orderStatus: "paid",
    orderNumber: "BT-SALE0001",
    dueDate: null,
    notes: null,
    createdAt: AS_OF,
    updatedAt: AS_OF,
    cancelledAt: null,
    physicalAppliedAt: AS_OF,
    lineItems: [
      {
        saleId: SALE,
        kind: "jar",
        jarSizeId: JAR_PINT,
        hiveId: null,
        itemId: null,
        productId: null,
        quantity: 2,
        unitPrice: 12,
        costBasisCents: null,
        label: "Pint",
        bottlingRunId: null,
        lotId: null,
        lotCode: null,
      },
    ],
  };
}

interface GiveAwayRow {
  id: string;
  date: string;
  purpose: "gift" | "own_use";
  recipient: string | null;
  notes: string | null;
  lines: {
    jarSizeId: string;
    label: string;
    harvestLotId: string | null;
    lotCode: string | null;
    varietal: string | null;
    quantity: number;
    unitRetailPrice: number | null;
    retailValue: number | null;
  }[];
  totalJars: number;
  retailValue: number;
  unpricedJars: number;
  reversed: boolean;
  reversedAt: string | null;
}

function giveAway(
  id: string,
  date: string,
  purpose: "gift" | "own_use",
  recipient: string | null,
  quantity: number,
): GiveAwayRow {
  return {
    id,
    date,
    purpose,
    recipient,
    notes: recipient,
    lines: [
      {
        jarSizeId: JAR_PINT,
        label: "Pint",
        harvestLotId: LOT_CLOVER,
        lotCode: "2026-CLOVER-01",
        varietal: "Clover",
        quantity,
        unitRetailPrice: 10,
        retailValue: quantity * 10,
      },
    ],
    totalJars: quantity,
    retailValue: quantity * 10,
    unpricedJars: 0,
    reversed: false,
    reversedAt: null,
  };
}

function stockInventory() {
  return {
    locations: [
      {
        id: HOME,
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
        createdAt: AS_OF,
        updatedAt: AS_OF,
        onHandUnits: 12,
        outstandingBalance: 0,
      },
    ],
    items: [
      {
        jarSizeId: JAR_PINT,
        productId: null,
        label: "Pint",
        kind: "jar",
        unitPrice: 10,
        total: 12,
        byLocation: { [HOME]: 12 },
        lots: [
          {
            harvestLotId: LOT_CLOVER,
            lotCode: "2026-CLOVER-01",
            varietalName: "Clover",
            total: 12,
            byLocation: { [HOME]: 12 },
          },
        ],
      },
    ],
  };
}

function jarInventory() {
  return [
    {
      jarSizeId: JAR_PINT,
      label: "Pint",
      honeyOz: 22,
      defaultPrice: 10,
      jarred: 20,
      sold: 8,
      givenAway: 0,
      adjusted: 0,
      onHand: 12,
    },
  ];
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

interface MockState {
  giveAways: GiveAwayRow[];
  sent: Sent[];
  registerKinds: string[];
}

function registerBody(state: MockState, kind: string) {
  const sales = [sale()];
  const entries = [
    ...(kind === "giveaways"
      ? []
      : sales.map((row) => ({ type: "sale", id: row.id, date: row.date, sale: row, giveAway: null }))),
    ...(kind === "sales"
      ? []
      : state.giveAways.map((row) => ({
          type: row.purpose === "own_use" ? "own_use" : "give_away",
          id: row.id,
          date: row.date,
          sale: null,
          giveAway: row,
        }))),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const live = state.giveAways.filter((row) => !row.reversed);
  return {
    entries,
    totals: {
      revenue: 24,
      salesCount: 1,
      givenAwayJars: live.filter((r) => r.purpose === "gift").reduce((n, r) => n + r.totalJars, 0),
      ownUseJars: live.filter((r) => r.purpose === "own_use").reduce((n, r) => n + r.totalJars, 0),
      retailValueGiven: live.reduce((n, r) => n + r.retailValue, 0),
    },
  };
}

async function mockApp(page: Page, state: MockState) {
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
          displayName: "Register test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Register test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (request.method() === "POST" && path.endsWith("/honey/give-away")) {
      const body = request.postDataJSON() as {
        date: string;
        purpose?: "gift" | "own_use";
        reason?: string;
        lines: { quantity: number }[];
      };
      state.sent.push({ method: "POST", path, body });
      const quantity = body.lines.reduce((n, line) => n + line.quantity, 0);
      state.giveAways.push(
        giveAway(
          "a5a5a5a5-5555-4555-8555-555555555555",
          `${body.date}T00:00:00Z`,
          body.purpose ?? "gift",
          body.reason ?? null,
          quantity,
        ),
      );
      return route.fulfill({ json: { success: true } });
    }
    if (request.method() === "DELETE" && path.includes("/honey/movements/")) {
      state.sent.push({ method: "DELETE", path, body: null });
      const id = path.split("/").pop();
      const row = state.giveAways.find((r) => r.id === id);
      if (row) {
        row.reversed = true;
        row.reversedAt = AS_OF;
      }
      return route.fulfill({ json: { success: true, reversed: true } });
    }
    if (request.method() !== "GET") {
      state.sent.push({ method: request.method(), path, body: request.postDataJSON() });
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith("/sales/register")) {
      const kind = url.searchParams.get("kind") ?? "all";
      state.registerKinds.push(kind);
      return route.fulfill({ json: registerBody(state, kind) });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith("/honey/inventory")) {
      return route.fulfill({ json: jarInventory() });
    }
    if (path.endsWith("/stock-locations/inventory")) {
      return route.fulfill({ json: stockInventory() });
    }
    if (path.endsWith("/stock-locations")) {
      return route.fulfill({ json: stockInventory().locations });
    }
    if (path.endsWith("/sales")) {
      return route.fulfill({ json: [sale()] });
    }
    return route.fulfill({ json: [] });
  });
}

function freshState(): MockState {
  return {
    giveAways: [
      giveAway(GIFT, "2026-09-04T00:00:00Z", "gift", "Neighbors", 2),
      giveAway(OWN_USE, "2026-09-01T00:00:00Z", "own_use", "Kitchen", 1),
    ],
    sent: [],
    registerKinds: [],
  };
}

test("give-aways and own use sit between the sales at $0 with their retail value muted", async ({
  page,
}) => {
  const state = freshState();
  await mockApp(page, state);
  await page.goto("/sales");

  const grid = page.getByRole("table", { name: "Honey sales" });
  const rows = grid.getByRole("row");
  // Header + gift (Sep 4) + sale (Sep 2) + own use (Sep 1), newest first.
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("Given away");
  await expect(rows.nth(1)).toContainText("Neighbors");
  await expect(rows.nth(1)).toContainText("2 × Pint");
  await expect(rows.nth(1)).toContainText("$0.00");
  await expect(rows.nth(1)).toContainText("2 jars · ≈ $20.00 retail");
  await expect(rows.nth(2)).toContainText("BT-SALE0001");
  await expect(rows.nth(2)).toContainText("$24.00");
  await expect(rows.nth(3)).toContainText("Own use");
  await expect(rows.nth(3)).toContainText("Kitchen");

  // Revenue is the sale only; the jars given are stated apart, as value.
  const totals = page.getByTestId("register-totals");
  await expect(totals).toContainText("1 sale · $24.00 revenue");
  await expect(totals).toContainText("2 jars given away, 1 own use");
  await expect(totals).toContainText("≈ $30.00 retail, not revenue");
});

test("the All / Sales / Given away filter lives in the URL", async ({ page }) => {
  const state = freshState();
  await mockApp(page, state);
  await page.goto("/sales");

  const grid = page.getByRole("table", { name: "Honey sales" });
  await expect(grid.getByRole("row")).toHaveCount(4);

  await page.getByRole("button", { name: "Given away & own use" }).click();
  await expect(page).toHaveURL(/[?&]show=giveaways/);
  await expect(page.getByRole("button", { name: "Given away & own use" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(grid.getByRole("row")).toHaveCount(3);
  await expect(grid).not.toContainText("BT-SALE0001");
  expect(state.registerKinds).toContain("giveaways");

  // A reload keeps the filter.
  await page.reload();
  await expect(page.getByRole("table", { name: "Honey sales" }).getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(page).toHaveURL(/[?&]show=sales/);
  const salesOnly = page.getByRole("table", { name: "Honey sales" });
  await expect(salesOnly.getByRole("row")).toHaveCount(2);
  await expect(salesOnly).toContainText("BT-SALE0001");

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/\/sales$/);
  await expect(page.getByRole("table", { name: "Honey sales" }).getByRole("row")).toHaveCount(4);
});

test("jars kept for own use appear in the register as soon as they are recorded", async ({
  page,
}) => {
  const state = freshState();
  await mockApp(page, state);
  await page.goto("/sales");
  await expect(page.getByRole("table", { name: "Honey sales" }).getByRole("row")).toHaveCount(4);

  await page.getByRole("button", { name: "Record" }).click();
  await page.getByRole("menuitem", { name: /Give away/ }).click();
  const dialog = page.getByRole("dialog", { name: "Give away jars" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("radio", { name: "Own use / kept for myself" }).check();
  await dialog.getByRole("combobox", { name: "Line 1 size" }).click();
  await page.getByRole("option", { name: /Pint/ }).click();
  await dialog.getByRole("textbox", { name: "Line 1 quantity" }).fill("3");
  await dialog.getByLabel("What for (optional)").fill("Baking");
  await dialog.getByRole("button", { name: "Record own use" }).click();
  await expect(dialog).toBeHidden();

  const posts = state.sent.filter((entry) => entry.path.endsWith("/honey/give-away"));
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toMatchObject({
    purpose: "own_use",
    reason: "Baking",
    lines: [{ jarSizeId: JAR_PINT, harvestLotId: LOT_CLOVER, quantity: 3 }],
  });

  // The register refetches: the new row is there without a reload.
  const grid = page.getByRole("table", { name: "Honey sales" });
  await expect(grid.getByRole("row")).toHaveCount(5);
  const added = grid.getByRole("row").filter({ hasText: "Baking" });
  await expect(added).toContainText("Own use");
  await expect(added).toContainText("3 × Pint");
  await expect(added).toContainText("3 jars · ≈ $30.00 retail");
});

test("a give-away is undone from its row after a confirmation", async ({ page }) => {
  const state = freshState();
  await mockApp(page, state);
  await page.goto("/sales");

  const grid = page.getByRole("table", { name: "Honey sales" });
  const gift = grid.getByRole("row").filter({ hasText: "Neighbors" });
  await gift.getByRole("button", { name: "Undo give-away" }).click();

  const confirm = page.getByRole("alertdialog", { name: "Undo this give-away?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("2 jars");
  await confirm.getByRole("button", { name: "Undo" }).click();

  await expect.poll(() => state.sent.filter((s) => s.method === "DELETE").length).toBe(1);
  expect(state.sent.find((s) => s.method === "DELETE")?.path).toBe(
    `/api/v1/honey/movements/${GIFT}`,
  );
  // The row stays, marked undone, with no undo action left.
  await expect(gift).toContainText("Undone");
  await expect(gift.getByRole("button", { name: "Undo give-away" })).toHaveCount(0);
  await expect(page.getByTestId("register-totals")).not.toContainText("2 jars given away");
});

test("on a phone each give-away is a card with its badge and undo action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = freshState();
  await mockApp(page, state);
  await page.goto("/sales");

  const card = page.locator("[data-grid-card]").filter({ hasText: "Neighbors" });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("register-zero-badge")).toHaveText("Given away");
  await expect(card.getByRole("button", { name: "Undo give-away" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
