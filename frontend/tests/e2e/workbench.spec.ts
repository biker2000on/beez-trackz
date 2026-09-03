import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The Production and Sales workbenches (design 2026-09-03 §3.2, §3.3, §4.8;
 * wave 4, frontend half).
 *
 * There is no component test runner in this repo, so wave 4's acceptance is
 * pinned here against the real pages driven by mocked read models:
 *
 *  - neither workbench is assembled from more than one call;
 *  - a shortfall or a lockout is on screen *before* the command that would be
 *    refused, not after it;
 *  - a forbidden command is a disabled control that states its reason;
 *  - a body replayed from the service worker cache is marked stale;
 *  - a mutation is the source command's own method and path, carrying an
 *    `X-Offline-Mutation-ID` bound to the command's identity.
 *
 * The backend routes are written in parallel with these pages, so every read
 * is `page.route`-mocked to the §4.8 shapes. That is deliberate: the shapes
 * are the contract, and this spec fails when the contract moves rather than
 * when a database happens to be empty.
 */

test.describe.configure({ mode: "serial" });

const SESSION = "aaaaaaaa-1111-1111-1111-111111111111";
const LOT_OPEN = "bbbbbbbb-2222-2222-2222-222222222222";
const LOT_LOCKED = "cccccccc-3333-3333-3333-333333333333";
const JAR_16 = "dddddddd-4444-4444-4444-444444444444";
const BATCH = "eeeeeeee-5555-5555-5555-555555555555";
const DRAFT = "ffffffff-6666-6666-6666-666666666666";
const LOCATION = "00000000-7777-7777-7777-777777777777";
const ITEM_16 = "11111111-8888-8888-8888-888888888888";

const AS_OF = "2026-09-03T12:00:00Z";

/**
 * The shell's own reads: session, actor and the display preferences every
 * screen formats through. None of them belongs to a workbench read model.
 */
const SHELL_READS = [
  "/api/v1/auth/status",
  "/api/v1/access/me",
  "/api/v1/settings",
];

/**
 * Navigation chrome, not workbench data — and there is none left.
 *
 * Wave 4 landed with ten entries here: `/sales/*` inherited
 * `sales/layout.tsx` → `SalesSectionNav` → `HoneyQuickActions`, which mounted
 * six record dialogs eagerly and so prefetched their option lists on every
 * sales route, the workbench included. Wave 5 deleted that layout — sales
 * navigation lives in the shell now, and the record dialogs are mounted by
 * `/sales` itself, the one page that needs them. The production section nav
 * hides itself on `/production/workbench` for the same reason.
 *
 * Keeping the (now empty) list rather than deleting `dataReads` is
 * deliberate: it is what fails when chrome creeps back onto either workbench.
 */
const CHROME_READS: string[] = [];

interface CommandOverrides {
  permitted?: boolean;
  deniedReason?: string | null;
  offline?: "queueable" | "online_only";
  offlineReason?: string | null;
}

function command(
  id: string,
  label: string,
  method: string,
  path: string,
  overrides: CommandOverrides = {},
) {
  return {
    id,
    label,
    method,
    path,
    bodyTemplate: {},
    permitted: overrides.permitted ?? true,
    deniedReason: overrides.deniedReason ?? null,
    offline: overrides.offline ?? "queueable",
    offlineReason: overrides.offlineReason ?? null,
    idempotencyKeyTemplate: `wb:${id}:{clientMutationId}`,
    keyboard: "",
  };
}

function serverFreshness() {
  return { origin: "server", cachedAt: null, stale: false };
}

function productionBody() {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    openSessions: [
      {
        id: SESSION,
        apiaryName: "North Ridge",
        date: "2026-09-02",
        entryCount: 7,
        calculatedTotalLbs: 118.5,
        trueUpDifferenceLbs: null,
        commands: [
          command(
            "harvest.add_entry",
            "Add entry",
            "POST",
            `/api/v1/harvest-sessions/${SESSION}/entries`,
          ),
          command(
            "harvest.true_up",
            "True up",
            "POST",
            `/api/v1/harvest-sessions/${SESSION}/true-up`,
          ),
        ],
      },
    ],
    bulkOnHand: [
      {
        lotId: LOT_OPEN,
        lotCode: "2026-CLOVER-01",
        varietal: "Clover",
        availableLbs: "42.250",
        lockedOut: false,
        lockoutUntil: null,
        commands: [
          command(
            "production.record_bottling",
            "Bottle this lot",
            "POST",
            "/api/v1/honey/jarring",
          ),
        ],
      },
      {
        lotId: LOT_LOCKED,
        lotCode: "2026-WILDFLOWER-02",
        varietal: "Wildflower",
        availableLbs: "18.000",
        lockedOut: true,
        lockoutUntil: "2026-09-20T00:00:00Z",
        lockoutReason: "Apivar applied 2026-08-21, 30-day withdrawal",
        commands: [
          command(
            "production.record_bottling",
            "Bottle this lot",
            "POST",
            "/api/v1/honey/jarring",
            {
              permitted: false,
              deniedReason:
                "lot 2026-WILDFLOWER-02 is locked out until 2026-09-20",
            },
          ),
        ],
      },
    ],
    lotsAwaitingBottling: [
      { lotId: LOT_OPEN, lotCode: "2026-CLOVER-01", availableLbs: "42.250" },
    ],
    jarStock: [
      {
        jarSizeId: JAR_16,
        label: "16 oz",
        onHand: 34,
        reserved: 6,
        available: 28,
        parLevel: 24,
      },
      {
        jarSizeId: "9-oz",
        label: "9 oz",
        onHand: 4,
        reserved: 0,
        available: 4,
        parLevel: 24,
      },
    ],
    productBatches: [{ id: BATCH, productName: "Creamed", onHand: 12 }],
    commands: [
      command(
        "production.start_session",
        "Start extraction",
        "POST",
        "/api/v1/harvest-sessions",
        {
          offline: "online_only",
          // §8 decision: "start extraction" stays online_only.
          offlineReason:
            "POST /api/v1/harvest-sessions is not in the offline queue manifest; it needs a connection",
        },
      ),
    ],
  };
}

function salesBody() {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    todayTakings: { salesCount: 4, revenueCents: 18500 },
    drafts: [
      {
        saleId: DRAFT,
        customerName: "Bike shop",
        lineCount: 3,
        shortfalls: [{ itemLabel: "16 oz", wanted: 12, available: 8 }],
        commands: [
          command("sales.apply", "Apply order", "POST", "/api/v1/sales", {
            permitted: false,
            deniedReason: "16 oz: 12 wanted, 8 available at the home location",
          }),
        ],
      },
    ],
    consignment: [
      {
        locationId: LOCATION,
        name: "Corner market",
        unitsOut: 24,
        settlementDueAt: "2026-09-30",
        lastSettledAt: "2026-08-31",
        commands: [
          command(
            "sales.settle",
            "Settle",
            "POST",
            `/api/v1/stock-locations/${LOCATION}/settlement`,
            {
              permitted: false,
              deniedReason: "admin access is required to settle consignment",
            },
          ),
        ],
      },
    ],
    sellable: [
      {
        itemId: ITEM_16,
        label: "16 oz",
        lotCode: "2026-CLOVER-01",
        availableAtHome: 28,
      },
    ],
    commands: [
      command("sales.record_sale", "Record sale", "POST", "/api/v1/sales"),
    ],
  };
}

interface MockOptions {
  /** Serve the workbench read with the service worker's stale marker. */
  stale?: boolean;
  /** Called for every mutation the page issues. */
  onCommand?: (route: Route) => void;
  /** Make the workbench read fail, to exercise the error state. */
  failRead?: boolean;
  /** Every `/api/v1` path the page requested, in order. */
  reads?: string[];
}

async function mockApp(page: Page, options: MockOptions = {}) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET") options.reads?.push(path);

    if (path.endsWith("/auth/status")) {
      return route.fulfill({
        json: {
          authenticated: true,
          setupComplete: true,
          oidcEnabled: false,
          passwordLogin: true,
          displayName: "Workbench test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Workbench test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }

    if (
      path.endsWith("/production/workbench") ||
      path.endsWith("/sales/workbench")
    ) {
      if (options.failRead) {
        return route.fulfill({ status: 500, json: { error: "database error" } });
      }
      return route.fulfill({
        json: path.endsWith("/production/workbench")
          ? productionBody()
          : salesBody(),
        headers: options.stale
          ? {
              "content-type": "application/json",
              // Exactly what sw.js/route.ts:400 stamps on a cache replay.
              "X-Beez-Cache": "stale",
              date: "Thu, 03 Sep 2026 11:00:00 GMT",
            }
          : { "content-type": "application/json" },
      });
    }

    if (request.method() !== "GET") {
      options.onCommand?.(route);
      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: [] });
  });
}

/** The reads that are neither the shell's nor the navigation chrome's. */
function dataReads(reads: string[]): string[] {
  return reads.filter(
    (path) => !SHELL_READS.includes(path) && !CHROME_READS.includes(path),
  );
}

test("the production workbench is assembled from exactly one call", async ({
  page,
}) => {
  const reads: string[] = [];
  await mockApp(page, { reads });
  await page.goto("/production/workbench");
  await expect(page.getByTestId("workbench-panel")).toHaveCount(5);

  // Not "one call per widget, five widgets": one read model, five panels.
  expect(dataReads(reads)).toEqual(["/api/v1/production/workbench"]);
});

test("the sales workbench is assembled from exactly one call", async ({
  page,
}) => {
  const reads: string[] = [];
  await mockApp(page, { reads });
  await page.goto("/sales/workbench");
  await expect(page.getByTestId("workbench-panel")).toHaveCount(4);

  expect(dataReads(reads)).toEqual(["/api/v1/sales/workbench"]);
});

test("production follows the journey in order, hive to finished stock", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/workbench");

  // §3.2: harvest → extraction → lot → bottling → finished stock, one screen.
  await expect(page.getByTestId("workbench-panel")).toHaveCount(5);
  const keys = await page
    .getByTestId("workbench-panel")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-panel-key")),
    );
  expect(keys).toEqual([
    "open-sessions",
    "bulk-on-hand",
    "awaiting-bottling",
    "jar-stock",
    "product-batches",
  ]);

  // Ledger quantities are rendered, and the exact server scale is kept.
  await expect(
    page.locator('[data-available-lbs="42.250"]').first(),
  ).toBeVisible();
  await expect(page.getByTestId("workbench-below-par")).toHaveCount(1);
});

test("a locked-out lot explains itself before its command refuses", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/workbench");

  const locked = page
    .getByTestId("workbench-row")
    .filter({ hasText: "2026-WILDFLOWER-02" });

  const explanation = locked.getByTestId("workbench-explanation");
  await expect(explanation).toContainText("locked out until 2026-09-20");
  await expect(explanation).toContainText(
    "Apivar applied 2026-08-21, 30-day withdrawal",
  );

  const bottle = locked.getByTestId("workbench-command");
  await expect(bottle).toBeDisabled();
  await expect(bottle).toHaveAttribute("data-blocked", "forbidden");

  // The explanation is *above* the refusal in the document, not after it: an
  // explanation that only appears once the server says no is an error message.
  const order = await locked
    .locator(
      '[data-testid="workbench-explanation"], [data-testid="workbench-command-reason"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
  expect(order[0]).toBe("workbench-explanation");
  expect(order).toContain("workbench-command-reason");

  // An unlocked lot in the same response carries no explanation and its
  // command is pressable — the page renders the server's answer per row.
  const open = page
    .getByTestId("workbench-row")
    .filter({ hasText: "2026-CLOVER-01" })
    .first();
  await expect(open.getByTestId("workbench-explanation")).toHaveCount(0);
  await expect(open.getByTestId("workbench-command")).toBeEnabled();
});

test("a draft states its shortfall before the order is refused", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/sales/workbench");

  const draft = page
    .getByTestId("workbench-row")
    .filter({ hasText: "Bike shop" });

  // CheckAvailability surfaced as a read (§4.8), in the server's numbers.
  const shortfall = draft.getByTestId("workbench-explanation");
  await expect(shortfall).toHaveAttribute("data-kind", "shortfall");
  await expect(shortfall).toContainText(
    "16 oz: 12 wanted, 8 available at home — short 4",
  );

  const order = await draft
    .locator(
      '[data-testid="workbench-explanation"], [data-testid="workbench-command-reason"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
  expect(order[0]).toBe("workbench-explanation");

  await expect(draft.getByTestId("workbench-command")).toBeDisabled();
});

test("a forbidden command is disabled and states its reason", async ({
  page,
}) => {
  const commands: string[] = [];
  await mockApp(page, {
    onCommand: (route) => commands.push(new URL(route.request().url()).pathname),
  });
  await page.goto("/sales/workbench");

  const settle = page
    .getByTestId("workbench-command")
    .filter({ hasText: "Settle" });
  await expect(settle).toBeDisabled();
  await expect(settle).toHaveAttribute("data-blocked", "forbidden");
  await expect(settle).toHaveAttribute(
    "aria-label",
    /admin access is required to settle consignment/,
  );
  // Visible, not only a tooltip: a disabled control that does not say why is
  // indistinguishable from a broken one.
  await expect(
    page.getByTestId("workbench-command-reason").filter({ hasText: "Settle" }),
  ).toContainText("admin access is required to settle consignment");

  await settle.click({ force: true }).catch(() => undefined);
  expect(commands).toEqual([]);
});

test("start extraction is online-only and says so while offline", async ({
  page,
  context,
}) => {
  await mockApp(page);
  await page.goto("/production/workbench");
  await expect(page.getByTestId("workbench-panel")).toHaveCount(5);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await expect(page.getByTestId("work-connection")).toHaveAttribute(
    "data-state",
    "offline",
  );

  const start = page
    .getByTestId("workbench-command")
    .filter({ hasText: "Start extraction" });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("data-blocked", "offline");
  await expect(
    page
      .getByTestId("workbench-command-reason")
      .filter({ hasText: "Start extraction" }),
  ).toContainText("not in the offline queue manifest");

  // A queueable command in the same response stays pressable.
  await expect(
    page.getByTestId("workbench-command").filter({ hasText: "Add entry" }),
  ).toBeEnabled();

  await context.setOffline(false);
});

test("a command runs its own source path with a command-bound mutation id", async ({
  page,
}) => {
  const seen: Array<{ path: string; method: string; mutationId: string | null }> =
    [];
  await mockApp(page, {
    onCommand: (route) => {
      const request = route.request();
      seen.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        mutationId: request.headers()["x-offline-mutation-id"] ?? null,
      });
    },
  });
  await page.goto("/production/workbench");

  await page
    .getByTestId("workbench-command")
    .filter({ hasText: "Add entry" })
    .click();

  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0].method).toBe("POST");
  // Not a generic workbench mutation (§4.8: there is no PUT /workbench).
  expect(seen[0].path).toBe(`/api/v1/harvest-sessions/${SESSION}/entries`);
  expect(seen[0].mutationId).toContain("harvest.add_entry");
  expect(seen[0].mutationId).not.toContain("{clientMutationId}");

  await expect(page.getByTestId("workbench-receipt")).toHaveAttribute(
    "data-phase",
    "done",
  );
});

test("a stale cached workbench is rendered as stale", async ({ page }) => {
  await mockApp(page, { stale: true });
  await page.goto("/production/workbench");

  const freshness = page.getByTestId("work-freshness");
  await expect(freshness).toHaveAttribute("data-state", "stale");
  await expect(freshness).toContainText("Stale");
});

test("a live workbench is not marked stale", async ({ page }) => {
  await mockApp(page, { stale: false });
  await page.goto("/sales/workbench");

  const freshness = page.getByTestId("work-freshness");
  await expect(freshness).toHaveAttribute("data-state", "server");
  await expect(freshness).toContainText("Live");
});

test("a failed read is an error state, not an empty workbench", async ({
  page,
}) => {
  await mockApp(page, { failRead: true });
  await page.goto("/production/workbench");

  await expect(page.getByTestId("workbench-error")).toBeVisible();
  await expect(page.getByTestId("workbench-panel")).toHaveCount(0);
});
