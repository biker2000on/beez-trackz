import { expect, test, type Page } from "@playwright/test";

/**
 * Every data-entry form says what is available for the choice it offers,
 * states its units, and totals as the operator types.
 *
 * The rule came out of the "Jar honey" review and was then applied to every
 * form: a lot/size picker shows what is left for that choice and hides
 * choices with nothing left; a jar size shows its honey ounces and a weight
 * its unit; and jars · ounces ≈ pounds, units · dollars, and "what this
 * leaves behind" are computed live, never only on submit.
 *
 * Every `/api/v1/**` read is `page.route`-mocked to the API's shapes, the way
 * `journeys.spec.ts` does it: the shape is the contract, and this spec must
 * fail when the contract moves rather than when a database happens to be
 * empty. The four forms pinned here are the ones whose data paths differ —
 * bulk per lot (`/honey/lot-balances`), jars per location and per lot (the
 * stock inventory matrix), jars at home (`/honey/inventory`) and a batch's
 * draw against a lot.
 */

test.describe.configure({ mode: "serial" });

const HOME = "99999999-0000-4000-8000-000000000000";
const LOT_CLOVER = "bbbbbbbb-2222-2222-2222-222222222222";
const LOT_WILDFLOWER = "cccccccc-3333-3333-3333-333333333333";
const JAR_PINT = "dddddddd-4444-4444-4444-444444444444";
const JAR_QUART = "eeeeeeee-5555-5555-5555-555555555555";
const PRODUCT = "ffffffff-6666-6666-6666-666666666666";
const AS_OF = "2026-09-03T12:00:00Z";

function harvestLot(id: string, lotCode: string, varietalName: string, lbs: number) {
  return {
    id,
    lotCode,
    publicSlug: lotCode.toLowerCase(),
    extractionDate: "2026-08-22",
    pulledOn: "2026-08-20",
    honeyWeightLbs: lbs,
    honeyWeightEntered: null,
    honeyWeightSource: "manual",
    derivedWeightLbs: 0,
    linkedHarvestCount: 0,
    varietalId: null,
    varietalName,
    claimSpecies: null,
    claimYear: 2026,
    claimApiaryId: null,
    claimApiaryName: null,
    claimElevationM: null,
    floralClaim: "",
    season: "Late summer 2026",
    apiaryRegion: null,
    bloomNotes: null,
    beekeeperStory: null,
    testingData: {},
    reorderUrl: null,
    isPublic: false,
    moisturePct: null,
    bottlingMoisturePct: null,
    moistureOverrideReason: null,
    moistureOverrideAt: null,
    lockout: null,
    sourceHarvestIds: [],
    sourceApiaries: [],
    photos: [],
    bottlingRuns: [],
    createdAt: AS_OF,
    updatedAt: AS_OF,
  };
}

/** Clover still holds bulk honey; Wildflower has all been jarred. */
function lotBalances() {
  return {
    lots: [
      {
        lotId: LOT_CLOVER,
        lotCode: "2026-CLOVER-01",
        varietalId: null,
        varietalName: "Clover",
        extractionDate: "2026-08-22",
        lotLbs: 60,
        jarredLbs: 17.75,
        bulkUsedLbs: 0,
        lossLbs: 0,
        onHandLbs: 42.25,
      },
      {
        lotId: LOT_WILDFLOWER,
        lotCode: "2026-WILDFLOWER-01",
        varietalId: null,
        varietalName: "Wildflower",
        extractionDate: "2026-08-22",
        lotLbs: 20,
        jarredLbs: 20,
        bulkUsedLbs: 0,
        lossLbs: 0,
        onHandLbs: 0,
      },
    ],
    unassigned: { lbs: 0, drawnLbs: 0, inLotsLbs: 0 },
    totals: {
      totalHarvestedLbs: 80,
      jarredLbs: 37.75,
      bulkUsedLbs: 0,
      lossLbs: 0,
      bulkOnHandLbs: 42.25,
    },
  };
}

/** Pints are on the shelf at home; every quart has been sold. */
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
    {
      jarSizeId: JAR_QUART,
      label: "Quart",
      honeyOz: 44,
      defaultPrice: 18,
      jarred: 6,
      sold: 6,
      givenAway: 0,
      adjusted: 0,
      onHand: 0,
    },
  ];
}

/**
 * The stock-locations matrix: the pints at home all came from the Clover
 * lot, so a sale from home can be pinned to Clover and never to Wildflower.
 */
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
          {
            harvestLotId: LOT_WILDFLOWER,
            lotCode: "2026-WILDFLOWER-01",
            varietalName: "Wildflower",
            total: 0,
            byLocation: {},
          },
        ],
      },
      {
        jarSizeId: JAR_QUART,
        productId: null,
        label: "Quart",
        kind: "jar",
        unitPrice: 18,
        total: 0,
        byLocation: {},
        lots: [],
      },
    ],
  };
}

function catalog() {
  return {
    items: [
      {
        id: PRODUCT,
        name: "Creamed honey",
        kind: "creamed_honey",
        unit: "jar",
        defaultPrice: 12,
        sizeLabel: "8 oz",
        netGrams: null,
        isActive: true,
        made: 0,
        sold: 0,
        adjusted: 0,
        onHand: 0,
        inStock: false,
        createdAt: AS_OF,
        updatedAt: AS_OF,
      },
    ],
    propolisOnHandGrams: 0,
  };
}

async function mockApp(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Availability test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Availability test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (request.method() !== "GET") {
      return route.fulfill({ json: { success: true, id: "new" } });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith("/harvest-lots")) {
      return route.fulfill({
        json: [
          harvestLot(LOT_CLOVER, "2026-CLOVER-01", "Clover", 60),
          harvestLot(LOT_WILDFLOWER, "2026-WILDFLOWER-01", "Wildflower", 20),
        ],
      });
    }
    if (path.endsWith("/honey/lot-balances")) {
      return route.fulfill({ json: lotBalances() });
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
    if (path.endsWith("/products")) {
      return route.fulfill({ json: catalog() });
    }
    return route.fulfill({ json: [] });
  });
}

test("a bottling run shows each size's ounces and totals jars · oz ≈ lb against the lot's bulk", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/lots");

  const clover = page.locator("[data-slot=card]", { hasText: "2026-CLOVER-01" }).first();
  await clover.getByRole("button", { name: "Add bottling run" }).click();
  const dialog = page.getByRole("dialog", { name: /Bottle 2026-CLOVER-01/ });
  await expect(dialog).toBeVisible();

  // The lot's bulk on hand is stated before anything is typed.
  await expect(dialog.getByText("42.25 lb of bulk honey left in 2026-CLOVER-01")).toBeVisible();

  // Each jar size names its honey ounces.
  await dialog.getByRole("combobox", { name: "Jar size" }).click();
  await expect(page.getByRole("option", { name: "Pint · 22 oz" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Quart · 44 oz" })).toBeVisible();
  await page.getByRole("option", { name: "Pint · 22 oz" }).click();

  // The weight field carries the operator's unit.
  await expect(dialog.getByLabel(/Honey used \(lb/)).toBeVisible();

  // Totals move with the count: 10 pints × 22 oz = 220 oz ≈ 13.75 lb, which
  // leaves 28.5 lb of the 42.25 lb in the lot.
  await dialog.getByLabel("Jars").fill("10");
  await expect(
    dialog.getByText("10 jars · 220 oz ≈ 13.75 lb · leaves 28.5 lb in 2026-CLOVER-01"),
  ).toBeVisible();

  // Over-draw is a warning in amber, never a block.
  await dialog.getByLabel("Jars").fill("40");
  await expect(dialog.getByText(/more than the 42.25 lb left in 2026-CLOVER-01/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record bottling run" })).toBeEnabled();
});

test("a sale hides sizes and lots with nothing at the selling shelf and totals units · $ live", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/sales");

  await page.getByRole("button", { name: "Record" }).click();
  await page.getByRole("menuitem", { name: /Record sale/ }).click();
  const dialog = page.getByRole("dialog", { name: "Record a sale" });
  await expect(dialog).toBeVisible();

  // Pints are at home with their ounces; quarts are all gone, so no row.
  await expect(dialog.getByText("Pint · 22 oz")).toBeVisible();
  await expect(dialog.getByText("12 on hand at home")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Quart quantity" })).toHaveCount(0);

  // Units and dollars follow the quantity as it is typed.
  await dialog.getByRole("textbox", { name: "Pint quantity" }).fill("2");
  await expect(dialog.getByText("2 jars · $20.00")).toBeVisible();
  await expect(dialog.getByText("2 units · subtotal $20.00")).toBeVisible();

  // The lot picker lists the jars each lot has at this shelf and drops the
  // lot with none.
  await dialog.getByRole("combobox").filter({ hasText: "Unassigned" }).click();
  await expect(page.getByRole("option", { name: /2026-CLOVER-01 .*12 jars at home/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /2026-WILDFLOWER-01/ })).toHaveCount(0);
  await page.getByRole("option", { name: /2026-CLOVER-01/ }).click();
  await expect(dialog.getByText("12 jars of 2026-CLOVER-01 at home · leaves 10")).toBeVisible();

  // Asking for more than the shelf holds warns; the API is what refuses.
  await dialog.getByRole("textbox", { name: "Pint quantity" }).fill("15");
  await expect(dialog.getByText(/More Pint than at home/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record sale" })).toBeEnabled();
});

test("giving jars away shows on hand and ounces per size and totals jars · oz", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/sales");

  await page.getByRole("button", { name: "Record" }).click();
  await page.getByRole("menuitem", { name: /Give away/ }).click();
  const dialog = page.getByRole("dialog", { name: "Give away jars" });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByText("Pint · 22 oz")).toBeVisible();
  await expect(dialog.getByText("12 on hand")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Quart quantity" })).toHaveCount(0);

  await expect(dialog.getByText("0 jars · 0 oz")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Pint quantity" }).fill("6");
  await expect(dialog.getByText("6 jars · 132 oz")).toBeVisible();

  await dialog.getByRole("textbox", { name: "Pint quantity" }).fill("13");
  await expect(dialog.getByText(/More Pint than on hand/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record give-away" })).toBeEnabled();
});

test("a product batch picks a lot by pounds left and says what it leaves", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/products");

  await page.getByRole("button", { name: "Record batch" }).click();
  const dialog = page.getByRole("dialog", { name: "Record a batch" });
  await expect(dialog).toBeVisible();

  // Quantity out names the product's unit and size.
  await expect(dialog.getByLabel("Quantity out (jar · 8 oz)")).toBeVisible();

  // Lots are offered with their bulk left; the empty one is not offered.
  await dialog.getByRole("combobox", { name: "Harvest lot" }).click();
  await expect(page.getByRole("option", { name: "2026-CLOVER-01 · Clover · 42.25 lb left" })).toBeVisible();
  await expect(page.getByRole("option", { name: /2026-WILDFLOWER-01/ })).toHaveCount(0);
  await page.getByRole("option", { name: /2026-CLOVER-01/ }).click();

  await dialog.getByLabel("Honey (lb)").fill("10");
  await expect(dialog.getByText("Uses 10 lb · leaves 32.25 lb in 2026-CLOVER-01")).toBeVisible();

  await dialog.getByLabel("Honey (lb)").fill("50");
  await expect(dialog.getByText(/more than the 42.25 lb left in that lot/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save batch" })).toBeEnabled();
});
