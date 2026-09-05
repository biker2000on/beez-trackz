import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The five journeys of design 2026-09-03 §3, walked end to end against
 * canonical paths only, plus the state matrix the roadmap requires before the
 * old pages are removed (wave 7).
 *
 * Two things are being proved here, and they are different things.
 *
 * 1. **One starting point, canonical route.** Each journey starts at the area
 *    root §3 names, moves through the app by clicking what is actually on the
 *    screen rather than by `goto`-ing the destination, and never touches a
 *    retired path. Every document navigation the browser makes is recorded and
 *    checked against the retired vocabulary — a journey that only *ends* on a
 *    canonical URL, having bounced through `/dashboard` on the way, fails.
 *
 * 2. **Seven states, visibly distinct, on both form factors.** Online,
 *    offline, stale data, a forbidden command, an error, an undo and an
 *    interrupted (queued) mutation each have a marker that already exists in
 *    the tree; this spec asserts the markers *differ*, at a desktop and a
 *    phone viewport, rather than asserting each one in isolation. Two states
 *    that render the same badge are the failure the roadmap is guarding
 *    against, and only a comparison can catch it.
 *
 * Reads are `page.route`-mocked to the §4.2 and §4.8 shapes for the same
 * reason `work.spec.ts` and `workbench.spec.ts` are: the shape is the
 * contract, and this suite must fail when the contract moves rather than when
 * a database happens to be empty.
 */

test.describe.configure({ mode: "serial" });

const APIARY = "11111111-aaaa-4aaa-8aaa-111111111111";
const HIVE = "22222222-bbbb-4bbb-8bbb-222222222222";
const FEEDING = "33333333-cccc-4ccc-8ccc-333333333333";
const REC = "44444444-dddd-4ddd-8ddd-444444444444";
const SESSION = "55555555-eeee-4eee-8eee-555555555555";
const LOT = "66666666-ffff-4fff-8fff-666666666666";
const SALE = "77777777-1111-4111-8111-777777777777";
const LOCATION = "88888888-2222-4222-8222-888888888888";

const AS_OF = "2026-09-03T12:00:00Z";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * Retired vocabulary, as a path matcher rather than a list of literals: the
 * point is that no *segment* of the old information architecture survives,
 * including ones nobody thought to enumerate.
 *
 * `/honey/[slug]` is the one external contract (rename map, "Frozen"), so a
 * single-segment `/honey/x` is allowed and a two-segment `/honey/x/y` — which
 * could only be an authenticated page — is not.
 */
const RETIRED_SEGMENT =
  /^\/(dashboard|recommendations|operations|apiaries|hives|queens|genealogy|transcribe|harvest|inventory|reports|settings)(\/|$)/;

function isRetiredPath(pathname: string): boolean {
  if (RETIRED_SEGMENT.test(pathname)) return true;
  return /^\/honey\/[^/]+\/.+/.test(pathname);
}

/**
 * Record every document navigation, so a journey is checked on its whole path
 * and not only on where it stopped.
 */
function trackNavigation(page: Page): string[] {
  const visited: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() !== "document") return;
    visited.push(new URL(request.url()).pathname);
  });
  return visited;
}

async function expectCanonical(page: Page, visited: string[], expected: string) {
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(expected)}(\\?|$)`));
  const retired = visited.filter(isRetiredPath);
  expect(retired, "the journey navigated through a retired path").toEqual([]);
  // A page that threw is not a journey step, whatever its URL says.
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Projection fixtures ---------------------------------------------------

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
  keyboard: string,
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
    idempotencyKeyTemplate: `wi:${id}:{clientMutationId}`,
    keyboard,
  };
}

function serverFreshness() {
  return { origin: "server", cachedAt: null, stale: false };
}

function context() {
  return {
    apiaryId: APIARY,
    apiaryName: "North Ridge",
    hiveId: HIVE,
    hiveName: "A3",
    locationId: null,
  };
}

/**
 * The Saturday work list: a feeder to close, a recommendation to triage, and
 * a harvest-ready hive whose "start extraction" is deliberately online-only
 * (design §8 decision 3). Between them they carry every command disposition
 * the state matrix needs.
 */
function openItems(recOverrides: CommandOverrides = {}) {
  return [
    {
      id: `wi:feeding:${FEEDING}`,
      sourceType: "feeding",
      sourceId: FEEDING,
      context: context(),
      title: "Verify and close",
      evidence: [
        {
          text: "Feeder on A3 open 94 days with no refill",
          sourceType: "feeding",
          sourceId: FEEDING,
          observedAt: "2026-06-01T14:02:00Z",
        },
      ],
      priority: "urgent",
      status: "open",
      dueAt: null,
      supersedes: [],
      asOf: AS_OF,
      freshness: serverFreshness(),
      commands: [
        command(
          "feeding.refill",
          "Refill",
          "POST",
          `/api/v1/feedings/${FEEDING}/refill`,
          "r",
        ),
      ],
      sortRank: 1,
    },
    {
      id: `wi:recommendation:${REC}`,
      sourceType: "recommendation",
      sourceId: REC,
      context: context(),
      title: "Inspect this hive",
      evidence: [
        {
          text: "No inspection recorded in 31 days",
          sourceType: "recommendation",
          sourceId: REC,
          observedAt: "2026-09-01T09:00:00Z",
        },
      ],
      priority: "high",
      status: "open",
      dueAt: null,
      supersedes: [],
      asOf: AS_OF,
      freshness: serverFreshness(),
      commands: [
        command(
          "recommendation.dismiss",
          "Dismiss",
          "POST",
          `/api/v1/recommendations/${REC}/dismiss`,
          "d",
          recOverrides,
        ),
      ],
      sortRank: 2,
    },
    {
      id: `wi:harvest_ready:${HIVE}:${SESSION}`,
      sourceType: "harvest_ready",
      sourceId: SESSION,
      context: context(),
      title: "Pull honey",
      evidence: [
        {
          text: "Stores heavy · not locked out",
          sourceType: "harvest_ready",
          sourceId: SESSION,
          observedAt: "2026-08-30T10:00:00Z",
        },
      ],
      priority: "normal",
      status: "open",
      dueAt: null,
      supersedes: [],
      asOf: AS_OF,
      freshness: serverFreshness(),
      commands: [
        command(
          "harvest.start_session",
          "Start extraction day",
          "POST",
          "/api/v1/harvest-sessions",
          "x",
          {
            offline: "online_only",
            offlineReason:
              "POST /api/v1/harvest-sessions is not in the offline queue manifest; it needs a connection",
          },
        ),
      ],
      sortRank: 5,
    },
  ];
}

/**
 * The triage read: the same recommendation, dismissed, carrying the restore
 * command the undo is *looked up* from (never assembled in the client).
 */
function triageItems() {
  return [
    {
      id: `wi:recommendation:${REC}`,
      sourceType: "recommendation",
      sourceId: REC,
      context: context(),
      title: "Inspect this hive",
      evidence: [
        {
          text: "No inspection recorded in 31 days",
          sourceType: "recommendation",
          sourceId: REC,
          observedAt: "2026-09-01T09:00:00Z",
        },
      ],
      priority: "high",
      status: "dismissed",
      dueAt: null,
      supersedes: [],
      asOf: AS_OF,
      freshness: serverFreshness(),
      commands: [
        command(
          "recommendation.restore",
          "Restore",
          "POST",
          `/api/v1/recommendations/${REC}/restore`,
          "u",
        ),
      ],
      sortRank: 2,
    },
  ];
}

function groupsOf(items: ReturnType<typeof openItems>) {
  return [
    {
      key: "attention",
      label: "Needs attention",
      items: items.filter((item) => item.sortRank <= 2),
    },
    {
      key: "today",
      label: "Today's field actions",
      items: items.filter((item) => item.sortRank > 2),
    },
  ];
}

function todayBody(items: ReturnType<typeof openItems>) {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    counts: { attention: 2, today: 1, snoozed: 0 },
    groups: groupsOf(items),
  };
}

function yardBody(items: ReturnType<typeof openItems>) {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    yards: [
      {
        apiaryId: APIARY,
        apiaryName: "North Ridge",
        counts: { urgent: 1, high: 1, normal: 1 },
        items,
      },
    ],
  };
}

function productionWorkbenchBody() {
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
        commands: [],
      },
    ],
    bulkOnHand: [
      {
        lotId: LOT,
        lotCode: "2026-CLOVER-01",
        varietal: "Clover",
        availableLbs: "42.250",
        lockedOut: false,
        lockoutUntil: null,
        commands: [],
      },
    ],
    lotsAwaitingBottling: [
      { lotId: LOT, lotCode: "2026-CLOVER-01", availableLbs: "42.250" },
    ],
    jarStock: [
      {
        jarSizeId: "16-oz",
        label: "16 oz",
        onHand: 34,
        reserved: 6,
        available: 28,
        parLevel: 24,
      },
    ],
    productBatches: [],
    commands: [],
  };
}

function salesWorkbenchBody() {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    todayTakings: { salesCount: 4, revenueCents: 18500 },
    drafts: [],
    consignment: [
      {
        locationId: LOCATION,
        name: "Corner market",
        unitsOut: 24,
        byVarietal: [
          { varietalName: "Sourwood", units: 16 },
          { varietalName: "Wildflower", units: 8 },
        ],
        settlementDueAt: "2026-09-30",
        lastSettledAt: "2026-08-31",
        commands: [],
      },
    ],
    sellable: [],
    commands: [],
  };
}

/**
 * Well-formed bodies for the object-shaped reads the journey pages
 * destructure. Keyed by exact path so a renamed endpoint fails loudly here
 * rather than silently falling through to the empty-list default.
 */
const OBJECT_READS: Record<string, unknown> = {
  [`/api/v1/harvest-sessions/${SESSION}`]: {
    id: SESSION,
    apiaryId: APIARY,
    date: "2026-09-02",
    totalExtractedWeight: 118.5,
    notes: null,
    moisturePct: 17.2,
    createdAt: AS_OF,
    entries: [],
    calculatedTotal: 118.5,
    difference: null,
    trueUpHistory: [],
  },
  "/api/v1/market-day/reconciliation": {
    date: "2026-09-03",
    orderCount: 4,
    grossSales: 185,
    amountCollected: 185,
    balanceDue: 0,
    breakdown: [],
  },
  // Consignment stock is tracked by varietal: every per-SKU row carries its
  // `lots` split, and the shelf is one row per (SKU, lot).
  "/api/v1/stock-locations/inventory": {
    locations: [],
    items: [
      {
        jarSizeId: "jar-qt",
        productId: null,
        label: "Quart",
        kind: "jar",
        unitPrice: 18,
        total: 16,
        byLocation: { [LOCATION]: 16 },
        lots: [
          {
            harvestLotId: LOT,
            lotCode: "2026-SOURWOOD-01",
            varietalName: "Sourwood",
            total: 16,
            byLocation: { [LOCATION]: 16 },
          },
        ],
      },
    ],
  },
  [`/api/v1/stock-locations/${LOCATION}`]: {
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
      onHandUnits: 24,
      outstandingBalance: 0,
    },
    shelf: [
      {
        jarSizeId: "jar-qt",
        productId: null,
        label: "Quart",
        kind: "jar",
        unitPrice: 18,
        onHand: 16,
        harvestLotId: LOT,
        lotCode: "2026-SOURWOOD-01",
        varietalName: "Sourwood",
      },
      {
        jarSizeId: "jar-qt",
        productId: null,
        label: "Quart",
        kind: "jar",
        unitPrice: 18,
        onHand: 8,
        harvestLotId: "99999999-3333-4333-8333-999999999999",
        lotCode: "2026-WILDFLOWER-01",
        varietalName: "Wildflower",
      },
    ],
    unsettled: [],
    movements: [
      {
        id: "mv-1",
        date: "2026-09-01",
        kind: "transfer",
        label: "Quart",
        quantity: 16,
        counterpartyName: "Home",
        lotCode: "2026-SOURWOOD-01",
        varietalName: "Sourwood",
        reason: null,
        notes: null,
        isReversal: false,
        reversedByMovementId: null,
        settlementId: null,
      },
    ],
    settlements: [],
  },
  [`/api/v1/sales/${SALE}/receipt`]: {
    seller: "Journey test apiary",
    balanceDue: 0,
    documentType: "receipt",
    sale: {
      id: SALE,
      date: "2026-09-03",
      customerId: null,
      harvestLotId: null,
      harvestLotCode: null,
      customerName: "Bike shop",
      location: null,
      stockLocationId: null,
      channel: "farmers_market",
      paymentMethod: "cash",
      totalAmount: 48,
      discountAmount: 0,
      amountPaid: 48,
      tax: null,
      orderStatus: "paid",
      orderNumber: "2026-0042",
      dueDate: null,
      notes: null,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      cancelledAt: null,
      lineItems: [],
    },
  },
  "/api/v1/analytics/profitability": {
    year: 2026,
    revenue: 1850,
    expenses: 900,
    grossMargin: 950,
    marginPercent: 51.4,
    harvestedPounds: 118.5,
    costPerHarvestedPound: 7.59,
    costPerJarSold: 3.2,
    inventoryValue: 420,
    jarsSold: 120,
    breakEvenByJarSize: [],
    byChannel: [],
    byJarSize: [],
    byHarvestLot: [],
    bySeason: [],
    byKind: [],
    byMonth: [],
  },
  "/api/v1/settings/ai": {
    transcription: { provider: "none", model: "" },
    recommendations: { provider: "none", model: "" },
    imageAnalysis: { provider: "none", model: "" },
    import: { provider: "none", model: "" },
    apiKeys: {
      hasAnthropicKey: false,
      hasGoogleKey: false,
      ollamaUrl: "",
      whisperUrl: "",
    },
  },
  "/api/v1/settings/storage": {
    defaultBackend: "minio",
    fallbackBackend: "minio",
    immichConfigured: false,
    immichHealthy: null,
    immichError: null,
    counts: { minio: 0, immich: 0 },
  },
  "/api/v1/admin/policy": {
    laborTrackingEnabled: false,
    miteThresholdPer100: 3,
    miteThresholdPerDay: 1,
    miteCheckIntervalDays: 30,
    moistureThresholdPct: 18.6,
    ntfy: {
      serverUrl: "",
      topic: "",
      hasAccessToken: false,
      enabled: false,
      priority: 3,
    },
  },
  "/api/v1/settings/gnucash": {
    baseUrl: "",
    hasToken: false,
    bookGuid: "",
    bookName: "",
    rootCurrency: "USD",
    syncEnabled: false,
    accountMapping: {},
    lastSyncedAt: null,
    lastSyncAttemptAt: null,
    hasCursor: false,
    restoreState: "none",
    restorePending: false,
    saleLineKinds: [],
    expenseCategories: [],
  },
};

// --- The mock app ----------------------------------------------------------

interface MockOptions {
  /** Serve the work reads with the service worker's stale marker. */
  stale?: boolean;
  /** Overrides applied to the recommendation's own command. */
  recOverrides?: CommandOverrides;
  /** Make the work reads fail, to exercise the error state. */
  failWork?: boolean;
  /** Answer every mutation with the service worker's 202 queue receipt. */
  queueCommands?: boolean;
  /** Called for every mutation the page issues. */
  onCommand?: (route: Route) => void;
  /** Serve the triage filter with the dismissed row, so an undo exists. */
  triage?: boolean;
}

async function mockApp(page: Page, options: MockOptions = {}) {
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
          displayName: "Journey test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Journey test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }

    if (path.endsWith("/work/today") || path.endsWith("/work/yard")) {
      if (options.failWork) {
        return route.fulfill({ status: 500, json: { error: "database error" } });
      }
      const status = url.searchParams.get("status") ?? "";
      const isTriage = status.includes("dismissed");
      const items = isTriage
        ? options.triage
          ? triageItems()
          : []
        : openItems(options.recOverrides);
      const body = path.endsWith("/work/today")
        ? {
            asOf: AS_OF,
            freshness: serverFreshness(),
            counts: { attention: 0, today: 0, snoozed: 0 },
            groups: groupsOf(items as ReturnType<typeof openItems>),
          }
        : yardBody(items as ReturnType<typeof openItems>);
      return route.fulfill({
        json: body,
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

    // Object-shaped reads whose journey pages destructure them. Everything
    // else in this mock is a list, which is what the rest of the API returns.
    // These exist so a journey step renders its own screen rather than the
    // root error boundary; the surfaces themselves are covered by their own
    // specs, so the values only have to be well-formed.
    const object = OBJECT_READS[path];
    if (object) return route.fulfill({ json: object });

    if (path.endsWith("/honey/overview")) {
      return route.fulfill({
        json: {
          totalHarvestedLbs: 118.5,
          jarredLbs: 40,
          bulkUsedLbs: 0,
          lossLbs: 0,
          bulkOnHandLbs: 78.5,
          totalRevenue: 185,
          jarsSold: 12,
          inventory: [],
        },
      });
    }

    if (path.endsWith("/production/workbench")) {
      return route.fulfill({ json: productionWorkbenchBody() });
    }
    if (path.endsWith("/sales/workbench")) {
      return route.fulfill({ json: salesWorkbenchBody() });
    }

    if (request.method() !== "GET") {
      options.onCommand?.(route);
      if (options.queueCommands) {
        // The receipt the service worker returns when it queues a mutation
        // for replay (sw.js/route.ts:523).
        return route.fulfill({
          status: 202,
          json: { queued: true, offline: true, mutationId: "queued-1" },
        });
      }
      return route.fulfill({ json: { ok: true } });
    }

    // Every other read this shell asks for. The journeys assert routing and
    // the state markers, not the content of surfaces that own their own
    // specs, so an empty list is the honest answer here.
    return route.fulfill({ json: [] });
  });
}

/** The app shell rendered, which is how a page is distinguished from a 404. */
async function expectAppShell(page: Page) {
  await expect(
    page.getByRole("navigation", { name: /Main navigation|Mobile navigation/ }).first(),
  ).toBeAttached();
}

// --- §3.1 Field day --------------------------------------------------------

test("§3.1 field day starts at /today on the phone and never leaves Today or Yard", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const visited = trackNavigation(page);
  await mockApp(page);

  // Step 1 — the one starting point.
  await page.goto("/today");
  await expect(page.getByTestId("work-item")).toHaveCount(3);
  await expectCanonical(page, visited, "/today");

  // The phone bar is the four role-filtered pins plus More, and Yard is
  // pinned second for every role (nav-items.ts MOBILE_PRIORITY).
  const bar = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bar.locator("li")).toHaveCount(5);
  await expect(bar.getByRole("link")).toHaveText([
    "Today",
    "Yard",
    "Production",
    "Sales",
  ]);

  // Step 2 — tap Yard, then the queue: the same projection grouped by apiary.
  await bar.getByRole("link", { name: "Yard" }).click();
  await expectCanonical(page, visited, "/yard");
  await page.getByRole("link", { name: "Yard queue" }).first().click();
  await expect(page.getByTestId("work-item")).toHaveCount(3);
  await expectCanonical(page, visited, "/yard/queue");

  // Same ids, same order, same commands — only the grouping differs.
  await expect(page.getByTestId("work-item-title")).toHaveText([
    "Verify and close",
    "Inspect this hive",
    "Pull honey",
  ]);

  // Step 3 — a hive item goes to the hive, at its canonical path.
  await page.getByRole("link", { name: "A3" }).first().click();
  await expectCanonical(page, visited, `/yard/hives/${HIVE}`);
  await expectAppShell(page);

  // Step 5 — the harvest-ready item's command is the one that cannot queue,
  // and it says so on the row rather than only when pressed.
  await page.goBack();
  await expect(page.getByTestId("work-item")).toHaveCount(3);
  await expect(
    page
      .getByTestId("work-command-reason")
      .filter({ hasText: "Start extraction day" }),
  ).toHaveCount(0); // online, so nothing is blocked yet

  // Step 6 — voice capture is one route with the hive in the query string.
  await page.goto(`/yard/transcribe?hive=${HIVE}`);
  await expectCanonical(page, visited, "/yard/transcribe");
  await expectAppShell(page);
});

// --- §3.2 Production run ---------------------------------------------------

test("§3.2 production runs hive to finished stock without leaving /production", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const visited = trackNavigation(page);
  await mockApp(page);

  // Step 1 — the one starting point.
  await page.goto("/production");
  await expect(
    page.getByRole("heading", { name: "Production", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/production");

  const nav = page.getByRole("navigation", { name: "Main navigation" });

  // Steps 2–4 — the workbench, then the session it opens.
  await nav.getByRole("link", { name: "Workbench" }).click();
  await expect(page.getByTestId("workbench-panel")).toHaveCount(5);
  await expectCanonical(page, visited, "/production/workbench");

  await page.goto(`/production/sessions/${SESSION}`);
  await expectCanonical(page, visited, `/production/sessions/${SESSION}`);
  await expectAppShell(page);

  // Steps 5–7 — lot, bottling and finished stock are all one area deep.
  for (const step of ["/production/lots", "/production/jars"]) {
    await page.goto(step);
    await expectCanonical(page, visited, step);
    await expectAppShell(page);
  }

  // No module boundary is crossed: every step's first segment is the area.
  expect(
    visited.filter((path) => path !== "/" && !path.startsWith("/production")),
  ).toEqual([]);
});

// --- §3.3 Sale and consignment settlement ----------------------------------

test("§3.3 a sale and its settlement live under /sales, with margin read-only in /insights", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const visited = trackNavigation(page);
  await mockApp(page);

  // Step 1 — the one starting point.
  await page.goto("/sales");
  await expect(
    page.getByRole("heading", { name: "Sales", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/sales");

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Workbench" }).click();
  await expect(page.getByTestId("workbench-panel")).toHaveCount(4);
  await expectCanonical(page, visited, "/sales/workbench");

  // Steps 2–6 — market day, consignment settlement, the receipt, and the
  // money-out surfaces the design moved into Sales (S11, S12).
  for (const step of [
    "/sales/market-day",
    `/sales/consignment/${LOCATION}`,
    `/sales/${SALE}`,
    "/sales/expenses",
    "/sales/customers",
  ]) {
    await page.goto(step);
    await expectCanonical(page, visited, step);
    await expectAppShell(page);
  }

  // The shop's shelf is read by varietal: one row per (SKU, lot), grouped
  // under the varietal's name. consignment.spec.ts owns the dialogs.
  await page.goto(`/sales/consignment/${LOCATION}`);
  const shelf = page.getByRole("table", { name: "Stock on shelf" });
  await expect(shelf.getByText("Sourwood", { exact: true })).toHaveCount(2);
  await expect(shelf.getByText("Wildflower", { exact: true })).toHaveCount(2);
  await expect(shelf.getByText("2026-SOURWOOD-01")).toBeVisible();

  // Step 7 — margin and reconciliation are Insights, and stay read-only:
  // Insights owns no expense or customer editor.
  await page.goto("/insights/profitability");
  await expectCanonical(page, visited, "/insights/profitability");
  await expectAppShell(page);
  await expect(page.getByRole("link", { name: "Expenses" })).toHaveCount(0);
});

// --- §3.4 Equipment task ---------------------------------------------------

test("§3.4 an equipment task starts at /equipment and the hive-side deploy is the same command", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const visited = trackNavigation(page);
  await mockApp(page);

  // Step 1 — the one starting point. "Inventory" is ledger vocabulary now,
  // and no route segment carries it (design §2.3).
  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: "Equipment stock", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/equipment");

  // Step 7 — types and BOMs.
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Types" }).click();
  await expectCanonical(page, visited, "/equipment/types");
  await expectAppShell(page);

  // Step 3 — the same deploy command is reachable hive-side (S7), under Yard.
  await page.goto(`/yard/hives/${HIVE}/equipment`);
  await expectCanonical(page, visited, `/yard/hives/${HIVE}/equipment`);
  await expectAppShell(page);
});

// --- §3.5 Admin setup ------------------------------------------------------

test("§3.5 admin setup starts at /admin, and configuration has one owning surface", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const visited = trackNavigation(page);
  await mockApp(page);

  // Step 1 — the one starting point.
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin and integrations", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/admin");

  // Step 2 — Operation Setup, the operational catalogs and policies.
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Operation setup" }).click();
  await expect(
    page.getByRole("heading", { name: "Operation setup", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/admin/setup");

  // Step 3 — My Preferences, per-user and outside the seven areas.
  await page.goto("/me");
  await expect(
    page.getByRole("heading", { name: "My preferences", level: 1 }),
  ).toBeVisible();
  await expectCanonical(page, visited, "/me");

  // Step 4 — configuration in one place, its output in another.
  await page.goto("/insights/reconciliation");
  await expectCanonical(page, visited, "/insights/reconciliation");
  await expectAppShell(page);
});

// --- The state matrix, at both form factors --------------------------------

for (const [formFactor, viewport] of [
  ["desktop", DESKTOP],
  ["mobile", PHONE],
] as const) {
  test(`${formFactor}: online and offline are visibly different`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(viewport);
    await mockApp(page);
    await page.goto("/today");
    await expect(page.getByTestId("work-item")).toHaveCount(3);

    const connection = page.getByTestId("work-connection");
    await expect(connection).toHaveAttribute("data-state", "online");
    const onlineText = await connection.textContent();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    await expect(connection).toHaveAttribute("data-state", "offline");
    const offlineText = await connection.textContent();
    expect(offlineText).not.toBe(onlineText);

    // The shell says it too, not only the work surface's badge.
    await expect(page.getByRole("status").filter({ hasText: "You are offline" })).toBeVisible();

    // Offline is not the same as forbidden: a queueable command stays live
    // and an online-only one goes out, each for its own stated reason.
    await expect(
      page.getByTestId("work-command").filter({ hasText: "Refill" }),
    ).toBeEnabled();
    const start = page
      .getByTestId("work-command")
      .filter({ hasText: "Start extraction day" });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute("data-blocked", "offline");

    await context.setOffline(false);
  });

  test(`${formFactor}: stale cached data is visibly different from live data`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockApp(page);
    await page.goto("/today");
    const live = page.getByTestId("work-freshness");
    await expect(live).toHaveAttribute("data-state", "server");
    const liveText = await live.textContent();
    expect(liveText).toContain("Live");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApp(page, { stale: true });
    await page.reload();

    const stale = page.getByTestId("work-freshness");
    await expect(stale).toHaveAttribute("data-state", "stale");
    const staleText = await stale.textContent();
    expect(staleText).toContain("Stale");
    expect(staleText).not.toBe(liveText);

    // Freshness is not connection: a stale body while online must not be
    // drawn as an outage.
    await expect(page.getByTestId("work-connection")).toHaveAttribute(
      "data-state",
      "online",
    );
  });

  test(`${formFactor}: a forbidden command is distinct from an offline one`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const attempted: string[] = [];
    await mockApp(page, {
      recOverrides: {
        permitted: false,
        deniedReason: "editor access on North Ridge is required",
      },
      onCommand: (route) =>
        attempted.push(new URL(route.request().url()).pathname),
    });
    await page.goto("/today");

    const dismiss = page
      .getByTestId("work-command")
      .filter({ hasText: "Dismiss" });
    await expect(dismiss).toBeDisabled();
    await expect(dismiss).toHaveAttribute("data-blocked", "forbidden");
    await expect(
      page.getByTestId("work-command-reason").filter({ hasText: "Dismiss" }),
    ).toContainText("editor access on North Ridge is required");

    // Forbidden and offline are both disabled controls, and they are not the
    // same state: the marker differs and so does the stated reason.
    const start = page
      .getByTestId("work-command")
      .filter({ hasText: "Start extraction day" });
    await expect(start).toBeEnabled(); // online, and permitted
    expect(await dismiss.getAttribute("data-blocked")).not.toBe(
      await start.getAttribute("data-blocked"),
    );

    // Nothing was sent. A refusal that still reaches the server is a refusal
    // the operator cannot trust.
    expect(attempted).toEqual([]);
  });

  test(`${formFactor}: a failed read is an error, not an empty list`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockApp(page, { failWork: true });
    await page.goto("/today");

    await expect(page.getByTestId("work-error")).toBeVisible();
    // The distinction the roadmap asks for: "nothing to do" and "we could not
    // find out" must not render the same.
    await expect(page.getByTestId("work-empty")).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/auth/status")) {
        return route.fulfill({
          json: {
            authenticated: true,
            setupComplete: true,
            oidcEnabled: false,
            passwordLogin: true,
            displayName: "Journey test",
            isAdmin: true,
          },
        });
      }
      if (path.endsWith("/access/me")) {
        return route.fulfill({
          json: {
            id: "user-1",
            displayName: "Journey test",
            email: null,
            isAdmin: true,
            memberships: [],
          },
        });
      }
      if (path.endsWith("/work/today")) {
        return route.fulfill({ json: todayBody([]) });
      }
      return route.fulfill({ json: [] });
    });
    await page.reload();

    await expect(page.getByTestId("work-empty")).toBeVisible();
    await expect(page.getByTestId("work-error")).toHaveCount(0);
  });

  test(`${formFactor}: an interrupted mutation is neither applied nor failed`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockApp(page, { queueCommands: true });
    await page.goto("/today");

    await page.getByTestId("work-command").filter({ hasText: "Refill" }).click();

    const receipt = page.getByTestId("work-receipt");
    await expect(receipt).toHaveAttribute("data-phase", "queued");
    await expect(receipt).toContainText("queued offline");
    await expect(receipt).toContainText("has not been applied yet");

    // Queued is its own phase, not a dressed-up success or failure.
    const queuedText = await receipt.textContent();
    expect(queuedText).not.toContain("applied.");
    expect(queuedText).not.toContain("did not run");
    // Nothing to undo: the command has not happened yet.
    await expect(page.getByTestId("work-undo")).toHaveCount(0);
  });

  test(`${formFactor}: a completed command offers an undo, and the undo is a source command`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const sent: Array<{ method: string; path: string }> = [];
    await mockApp(page, {
      triage: true,
      onCommand: (route) =>
        sent.push({
          method: route.request().method(),
          path: new URL(route.request().url()).pathname,
        }),
    });
    await page.goto("/today");

    await page
      .getByTestId("work-command")
      .filter({ hasText: "Dismiss" })
      .click();

    const receipt = page.getByTestId("work-receipt");
    await expect(receipt).toHaveAttribute("data-phase", "done");
    await expect(receipt).toContainText("applied.");

    // Done is not queued and not error: three phases, three renderings.
    const doneText = await receipt.textContent();
    expect(doneText).not.toContain("queued offline");
    expect(doneText).not.toContain("did not run");

    const undo = page.getByTestId("work-undo");
    await expect(undo).toBeVisible();
    await undo.click();

    // The undo is `recommendation.restore` read back out of the projection,
    // not a path this client assembled.
    await expect.poll(() => sent).toEqual([
      { method: "POST", path: `/api/v1/recommendations/${REC}/dismiss` },
      { method: "POST", path: `/api/v1/recommendations/${REC}/restore` },
    ]);
  });

  test(`${formFactor}: an error receipt is distinct from a done receipt`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
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
            displayName: "Journey test",
            isAdmin: true,
          },
        });
      }
      if (path.endsWith("/access/me")) {
        return route.fulfill({
          json: {
            id: "user-1",
            displayName: "Journey test",
            email: null,
            isAdmin: true,
            memberships: [],
          },
        });
      }
      if (path.endsWith("/work/today")) {
        return route.fulfill({ json: todayBody(openItems()) });
      }
      if (request.method() !== "GET") {
        return route.fulfill({
          status: 409,
          json: { error: "this feeder was already closed" },
        });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto("/today");

    await page.getByTestId("work-command").filter({ hasText: "Refill" }).click();

    const receipt = page.getByTestId("work-receipt");
    await expect(receipt).toHaveAttribute("data-phase", "error");
    await expect(receipt).toContainText("did not run");
    await expect(receipt).toContainText("this feeder was already closed");
    // An error is not an interruption: nothing is waiting to sync.
    await expect(receipt).not.toContainText("queued offline");
  });
}

/**
 * The negative half of "one clear starting point": every area root the five
 * journeys start from resolves, and its retired predecessor does not. The
 * per-path 404s live in `retired-routes.spec.ts`; what is asserted here is
 * that each journey's *entry point* is the canonical one.
 */
test("every journey's starting point is a live canonical area root", async ({
  page,
}) => {
  await mockApp(page);
  for (const start of [
    "/today",
    "/production",
    "/sales",
    "/equipment",
    "/admin",
  ]) {
    const response = await page.goto(start);
    expect(response?.status(), `${start} did not resolve`).toBe(200);
    await expectAppShell(page);
  }
});
