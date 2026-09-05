import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Consignment by varietal.
 *
 * A shop that holds twelve Sourwood quarts and five Wildflower quarts has two
 * shelf rows, is sent stock lot by lot, reports sales lot by lot and hands
 * jars back lot by lot. This spec pins the frontend half of that contract
 * against mocked reads — `GET /stock-locations/{id}` with one shelf row per
 * (SKU, lot), `GET /stock-locations/inventory` with each SKU's `lots` split,
 * and the sales workbench's `byVarietal` — and asserts what the page *posts*:
 * a transfer or settlement line names its `harvestLotId`, and the "any lot"
 * escape hatch names none.
 */

test.describe.configure({ mode: "serial" });

const LOCATION = "88888888-2222-4222-8222-888888888888";
const HOME = "99999999-0000-4000-8000-000000000000";
const LOT_SOURWOOD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const LOT_WILDFLOWER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const JAR_QT = "cccccccc-3333-4333-8333-cccccccccccc";
const JAR_PT = "dddddddd-4444-4444-8444-dddddddddddd";
const AS_OF = "2026-09-03T12:00:00Z";

function lot(
  harvestLotId: string,
  lotCode: string,
  varietalName: string,
  total: number,
  byLocation: Record<string, number>,
) {
  return { harvestLotId, lotCode, varietalName, total, byLocation };
}

const SOURWOOD = { lotCode: "2026-SOURWOOD-01", varietalName: "Sourwood" };
const WILDFLOWER = { lotCode: "2026-WILDFLOWER-01", varietalName: "Wildflower" };

function shelfRow(
  jarSizeId: string,
  label: string,
  unitPrice: number,
  onHand: number,
  lotRef: { harvestLotId: string | null; lotCode: string | null; varietalName: string | null },
) {
  return {
    jarSizeId,
    productId: null,
    label,
    kind: "jar",
    unitPrice,
    onHand,
    ...lotRef,
  };
}

function locationDetail() {
  return {
    location: {
      id: LOCATION,
      name: "Corner market",
      slug: "corner-market",
      isHome: false,
      isConsignment: true,
      customerId: null,
      customerName: null,
      priceBasis: "commission",
      commissionBps: 3000,
      wholesalePriceListId: null,
      wholesalePriceListName: null,
      settlementCadence: "monthly",
      address: null,
      notes: null,
      isActive: true,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      onHandUnits: 17,
      outstandingBalance: 0,
    },
    // Deliberately out of order: the page sorts varietal → lot → size.
    shelf: [
      shelfRow(JAR_QT, "Quart", 18, 5, { harvestLotId: LOT_WILDFLOWER, ...WILDFLOWER }),
      shelfRow(JAR_PT, "Pint", 10, 4, { harvestLotId: LOT_SOURWOOD, ...SOURWOOD }),
      shelfRow(JAR_QT, "Quart", 18, 8, { harvestLotId: LOT_SOURWOOD, ...SOURWOOD }),
    ],
    unsettled: [],
    movements: [
      {
        id: "mv-1",
        date: "2026-09-01",
        kind: "transfer",
        label: "Quart",
        quantity: 8,
        counterpartyName: "Home",
        lotCode: SOURWOOD.lotCode,
        varietalName: SOURWOOD.varietalName,
        reason: null,
        notes: null,
        isReversal: false,
        reversedByMovementId: null,
        settlementId: null,
      },
    ],
    settlements: [
      {
        id: "st-1",
        locationId: LOCATION,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        reportedAt: AS_OF,
        saleId: null,
        orderNumber: "CM-0001",
        amountOwed: 37.8,
        amountPaid: 37.8,
        commission: 16.2,
        notes: null,
        createdAt: AS_OF,
        voidedAt: null,
        voidReason: null,
        lines: [
          {
            jarSizeId: JAR_QT,
            productId: null,
            label: "Quart",
            harvestLotId: LOT_SOURWOOD,
            ...SOURWOOD,
            quantitySold: 3,
            quantityReturned: 0,
            unitPrice: 18,
          },
        ],
      },
    ],
  };
}

function inventory() {
  return {
    locations: [
      { id: HOME, name: "Home", slug: "home", isHome: true, isConsignment: false },
      { id: LOCATION, name: "Corner market", slug: "corner-market", isHome: false, isConsignment: true },
    ],
    items: [
      {
        jarSizeId: JAR_QT,
        productId: null,
        label: "Quart",
        kind: "jar",
        unitPrice: 18,
        total: 33,
        byLocation: { [HOME]: 20, [LOCATION]: 13 },
        lots: [
          lot(LOT_SOURWOOD, SOURWOOD.lotCode, SOURWOOD.varietalName, 20, { [HOME]: 12, [LOCATION]: 8 }),
          lot(LOT_WILDFLOWER, WILDFLOWER.lotCode, WILDFLOWER.varietalName, 13, { [HOME]: 8, [LOCATION]: 5 }),
        ],
      },
      {
        jarSizeId: JAR_PT,
        productId: null,
        label: "Pint",
        kind: "jar",
        unitPrice: 10,
        total: 4,
        byLocation: { [LOCATION]: 4 },
        lots: [lot(LOT_SOURWOOD, SOURWOOD.lotCode, SOURWOOD.varietalName, 4, { [LOCATION]: 4 })],
      },
    ],
  };
}

function salesWorkbench() {
  return {
    asOf: AS_OF,
    freshness: { origin: "server", cachedAt: null, stale: false },
    todayTakings: { salesCount: 0, revenueCents: 0 },
    drafts: [],
    consignment: [
      {
        locationId: LOCATION,
        name: "Corner market",
        unitsOut: 17,
        byVarietal: [
          { varietalName: "Sourwood", units: 12 },
          { varietalName: "Wildflower", units: 5 },
        ],
        settlementDueAt: "2026-09-30",
        lastSettledAt: "2026-08-31",
        commands: [],
      },
      {
        locationId: "77777777-1111-4111-8111-777777777777",
        name: "Old body",
        unitsOut: 3,
        settlementDueAt: null,
        lastSettledAt: null,
        commands: [],
      },
    ],
    sellable: [],
    commands: [],
  };
}

interface Posted {
  path: string;
  body: unknown;
}

async function mockApp(page: Page, posted: Posted[]) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Consignment test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Consignment test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }

    if (request.method() !== "GET") {
      posted.push({ path, body: request.postDataJSON() });
      return route.fulfill({
        json: { id: "new", saleId: null, amountOwed: 0, amountPaid: 0, balanceDue: 0, commission: 0 },
      });
    }

    if (path === `/api/v1/stock-locations/${LOCATION}`) {
      return route.fulfill({ json: locationDetail() });
    }
    if (path === "/api/v1/stock-locations/inventory") {
      return route.fulfill({ json: inventory() });
    }
    if (path.endsWith("/sales/workbench")) {
      return route.fulfill({ json: salesWorkbench() });
    }
    return route.fulfill({ json: [] });
  });
}

test("the shelf is one row per lot, grouped by varietal and sorted varietal → lot → size", async ({
  page,
}) => {
  const posted: Posted[] = [];
  await mockApp(page, posted);
  await page.goto(`/sales/consignment/${LOCATION}`);

  const shelf = page.getByRole("table", { name: "Stock on shelf" });
  await expect(shelf).toBeVisible();

  // Group headers appear once per varietal, in varietal order, and each data
  // row names its varietal, lot and size.
  const rows = shelf.locator("tbody tr");
  await expect(rows).toHaveText([
    /^Sourwood$/,
    /Sourwood2026-SOURWOOD-01Pint4\$10\.00/,
    /Sourwood2026-SOURWOOD-01Quart8\$18\.00/,
    /^Wildflower$/,
    /Wildflower2026-WILDFLOWER-01Quart5\$18\.00/,
  ]);

  // The summary still adds up across lots.
  await expect(page.getByText("On shelf", { exact: true }).locator("..")).toContainText("17");
  await expect(page.getByText("2 varietals")).toBeVisible();

  // Movement rows say which lot and varietal moved; a report names what sold.
  await expect(
    page.getByRole("table", { name: "Movements" }).getByText("lot 2026-SOURWOOD-01 · Sourwood"),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Reports" }).getByText("3 Quart Sourwood sold"),
  ).toBeVisible();
});

test("sending stock picks a lot with its home count and posts harvestLotId; any lot posts none", async ({
  page,
}) => {
  const posted: Posted[] = [];
  await mockApp(page, posted);
  await page.goto(`/sales/consignment/${LOCATION}`);

  await page.getByRole("button", { name: "Send stock" }).click();
  const dialog = page.getByRole("dialog", { name: /Send stock to Corner market/ });
  await expect(dialog).toBeVisible();

  // Only what is at home is offered: pints are all out on consignment.
  await dialog.getByRole("combobox", { name: "Line 1 size" }).click();
  await expect(page.getByRole("option", { name: /Pint/ })).toHaveCount(0);
  await page.getByRole("option", { name: /Quart/ }).click();

  // The lot select lists each lot with what is at home, plus the escape hatch.
  await dialog.getByRole("combobox", { name: "Line 1 varietal" }).click();
  await expect(page.getByRole("option", { name: /Any lot \(oldest first\)/ })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Sourwood · 2026-SOURWOOD-01 · 12 at home/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Wildflower · 2026-WILDFLOWER-01 · 8 at home/ }),
  ).toBeVisible();
  await page.getByRole("option", { name: /Sourwood · 2026-SOURWOOD-01/ }).click();

  // Quantity is capped at that lot's home count, not the SKU's.
  const qty = dialog.getByRole("textbox", { name: "Line 1 quantity" });
  await expect(qty).toHaveAttribute("max", "12");
  await qty.fill("30");
  await expect(dialog.getByRole("button", { name: "Send 12 units" })).toBeVisible();
  await qty.fill("6");

  // A second line that does not care which lot goes.
  await dialog.getByRole("button", { name: "Add a line" }).click();
  await dialog.getByRole("combobox", { name: "Line 2 size" }).click();
  await page.getByRole("option", { name: /Quart/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Line 2 quantity" })).toHaveAttribute(
    "max",
    "20",
  );
  await dialog.getByRole("textbox", { name: "Line 2 quantity" }).fill("2");

  await dialog.getByRole("button", { name: "Send 8 units" }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].path).toBe(`/api/v1/stock-locations/${LOCATION}/transfers`);
  expect(posted[0].body).toMatchObject({
    lines: [
      { jarSizeId: JAR_QT, quantity: 6, harvestLotId: LOT_SOURWOOD },
      { jarSizeId: JAR_QT, quantity: 2 },
    ],
  });
  expect((posted[0].body as { lines: Record<string, unknown>[] }).lines[1]).not.toHaveProperty(
    "harvestLotId",
  );
});

test("bringing stock home is one count per shelf row and posts the row's harvestLotId", async ({
  page,
}) => {
  const posted: Posted[] = [];
  await mockApp(page, posted);
  await page.goto(`/sales/consignment/${LOCATION}`);

  await page.getByRole("button", { name: "Bring stock home" }).click();
  const dialog = page.getByRole("dialog", { name: /Bring stock home/ });
  await expect(dialog).toBeVisible();

  const wildflower = dialog.getByRole("textbox", {
    name: "Quart · Wildflower · 2026-WILDFLOWER-01 coming home",
  });
  await expect(wildflower).toHaveAttribute("max", "5");
  await wildflower.fill("3");
  await dialog.getByRole("button", { name: "Bring 3 units home" }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].path).toBe(`/api/v1/stock-locations/${LOCATION}/returns`);
  expect(posted[0].body).toMatchObject({
    lines: [{ jarSizeId: JAR_QT, quantity: 3, harvestLotId: LOT_WILDFLOWER }],
  });
});

test("their report is one row per lot, refuses an over-count by varietal, and posts harvestLotId", async ({
  page,
}) => {
  const posted: Posted[] = [];
  await mockApp(page, posted);
  await page.goto(`/sales/consignment/${LOCATION}`);

  await page.getByRole("button", { name: "Record their report" }).click();
  const dialog = page.getByRole("dialog", { name: /Record Corner market/ });
  await expect(dialog).toBeVisible();

  const grid = dialog.getByRole("table", { name: "Corner market report lines" });
  await expect(grid.locator("tbody tr")).toHaveCount(5);

  const sourwoodQt = dialog.getByRole("textbox", {
    name: "Quart · Sourwood · 2026-SOURWOOD-01 sold",
  });
  await expect(sourwoodQt).toHaveAttribute("max", "8");

  // Over-counting one lot is refused by name, even when the SKU as a whole
  // holds enough (there are 13 quarts on the shelf, 8 of them Sourwood).
  await sourwoodQt.fill("9");
  await expect(
    dialog.getByText("Sourwood Quart (lot 2026-SOURWOOD-01): 9 accounted for, but only 8 are on their shelf."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record report" })).toBeDisabled();

  await sourwoodQt.fill("3");
  await dialog
    .getByRole("textbox", { name: "Quart · Wildflower · 2026-WILDFLOWER-01 returned" })
    .fill("2");
  // 3 × $18 less the 30% cut.
  await expect(dialog.getByText("$37.80")).toBeVisible();
  await dialog.getByRole("button", { name: "Record report" }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].path).toBe(`/api/v1/stock-locations/${LOCATION}/settlements`);
  expect(posted[0].body).toMatchObject({
    amountPaid: 37.8,
    lines: [
      { jarSizeId: JAR_QT, harvestLotId: LOT_SOURWOOD, quantitySold: 3, quantityReturned: 0 },
      { jarSizeId: JAR_QT, harvestLotId: LOT_WILDFLOWER, quantitySold: 0, quantityReturned: 2 },
    ],
  });
});

test("the sales workbench says what is out by varietal, and falls back to the unit total", async ({
  page,
}) => {
  const posted: Posted[] = [];
  await mockApp(page, posted);
  await page.goto("/sales/workbench");

  const out = page.getByTestId("workbench-consignment-out");
  await expect(out).toHaveCount(2);
  await expect(out.nth(0)).toContainText("12 Sourwood · 5 Wildflower out");
  await expect(out.nth(1)).toContainText("3 out");
});
