import { expect, test, type Page } from "@playwright/test";

/**
 * A recorded sale's customer and context can be corrected after the fact —
 * from the receipt page and from the sales list's row action — through
 * PATCH /sales/{id}/details, which sends only what changed.
 *
 * Every `/api/v1/**` call is `page.route`-mocked to the API's shapes (see
 * form-availability.spec.ts): the request body is the contract pinned here.
 */

test.describe.configure({ mode: "serial" });

const SALE = "a1a1a1a1-1111-4111-8111-111111111111";
const CONSIGNMENT_SALE = "a2a2a2a2-2222-4222-8222-222222222222";
const ANN = "b1b1b1b1-3333-4333-8333-333333333333";
const JANE = "b2b2b2b2-4444-4444-8444-444444444444";
const STORE_LOCATION = "c1c1c1c1-5555-4555-8555-555555555555";
const AS_OF = "2026-09-03T12:00:00Z";

function customer(id: string, name: string, companyName: string | null) {
  return {
    id,
    name,
    companyName,
    email: null,
    phone: null,
    notes: null,
    emailOptIn: false,
    referralCode: null,
    referredBy: null,
    orderCount: 1,
    lifetimeRevenue: 24,
    lastOrderDate: "2026-09-01",
    reorderReminderDue: false,
  };
}

function sale(overrides: Record<string, unknown> = {}) {
  return {
    id: SALE,
    date: "2026-09-01T00:00:00Z",
    customerId: ANN,
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
    orderNumber: "BT-EDITME01",
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
        jarSizeId: "d1d1d1d1-6666-4666-8666-666666666666",
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
    ...overrides,
  };
}

function consignmentSale() {
  return sale({
    id: CONSIGNMENT_SALE,
    customerId: ANN,
    customerName: "Ann Buyer",
    location: "Bike shop",
    channel: "consignment",
    stockLocationId: STORE_LOCATION,
    orderNumber: "BT-SETTLED1",
    paymentMethod: "check",
  });
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

async function mockApp(page: Page, sent: Sent[]) {
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
          displayName: "Sale details test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Sale details test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (request.method() !== "GET") {
      sent.push({ method: request.method(), path, body: request.postDataJSON() });
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith(`/sales/${SALE}/receipt`)) {
      return route.fulfill({
        json: { seller: "Test Apiary", sale: sale(), balanceDue: 0, documentType: "receipt" },
      });
    }
    if (path.endsWith("/sales/locations")) {
      return route.fulfill({ json: ["Farm stand", "Saturday market"] });
    }
    if (path.endsWith("/api/v1/sales")) {
      return route.fulfill({ json: [sale(), consignmentSale()] });
    }
    if (path.endsWith("/customers")) {
      return route.fulfill({
        json: [
          customer(ANN, "Ann Buyer", null),
          customer(JANE, "Jane Doe", "Carolina Pedal Works"),
        ],
      });
    }
    return route.fulfill({ json: [] });
  });
}

test("the receipt page edits a sale's customer and notes, sending only what changed", async ({
  page,
}) => {
  const sent: Sent[] = [];
  await mockApp(page, sent);
  await page.goto(`/sales/${SALE}`);

  await page.getByRole("button", { name: "Edit details" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit sale details" });
  await expect(dialog).toBeVisible();

  // Prefilled from the sale.
  await expect(dialog.getByRole("combobox", { name: "Customer" })).toHaveText("Ann Buyer");
  await expect(dialog.getByLabel("Location")).toHaveValue("Farm stand");

  // Saved customers are listed by display name, company first.
  await dialog.getByRole("combobox", { name: "Customer" }).click();
  await page.getByRole("option", { name: "Carolina Pedal Works — Jane Doe" }).click();
  await dialog.getByLabel("Notes").fill("Picked up for the shop's open house");
  await dialog.getByRole("button", { name: "Save details" }).click();

  await expect(dialog).toBeHidden();
  const patches = sent.filter((entry) => entry.path.endsWith("/details"));
  expect(patches).toHaveLength(1);
  expect(patches[0].method).toBe("PATCH");
  expect(patches[0].path).toBe(`/api/v1/sales/${SALE}/details`);
  // Location was untouched, so it is not sent.
  expect(patches[0].body).toEqual({
    customerId: JANE,
    customerName: null,
    notes: "Picked up for the shop's open house",
  });
});

test("the sales list's row action edits a sale to a walk-in name; a consignment settlement keeps its store", async ({
  page,
}) => {
  const sent: Sent[] = [];
  await mockApp(page, sent);
  await page.goto("/sales");

  const row = page.getByRole("row").filter({ hasText: "BT-EDITME01" }).first();
  await row.getByRole("button", { name: "Edit sale details" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit sale details" });
  await expect(dialog).toBeVisible();
  // Opening the dialog does not open the receipt.
  await expect(page).toHaveURL(/\/sales$/);

  await dialog.getByRole("combobox", { name: "Customer" }).click();
  await page.getByRole("option", { name: "No saved customer / walk-in name" }).click();
  await dialog.getByLabel("Walk-in name").fill("Regular in the red truck");
  await dialog.getByRole("button", { name: "Save details" }).click();

  await expect(dialog).toBeHidden();
  const patches = sent.filter((entry) => entry.path.endsWith("/details"));
  expect(patches).toHaveLength(1);
  expect(patches[0].path).toBe(`/api/v1/sales/${SALE}/details`);
  expect(patches[0].body).toEqual({ customerId: null, customerName: "Regular in the red truck" });

  // A consignment settlement's customer and location follow the store; only
  // its notes are editable.
  const settled = page.getByRole("row").filter({ hasText: "BT-SETTLED1" }).first();
  await settled.getByRole("button", { name: "Edit sale details" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/consignment settlement/)).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Customer" })).toBeDisabled();
  await expect(dialog.getByLabel("Location")).toBeDisabled();
  await dialog.getByLabel("Notes").fill("Shelf by the register");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog).toBeHidden();

  const consignmentPatches = sent.filter((entry) =>
    entry.path.endsWith(`/sales/${CONSIGNMENT_SALE}/details`),
  );
  expect(consignmentPatches).toHaveLength(1);
  expect(consignmentPatches[0].body).toEqual({ notes: "Shelf by the register" });
});
