import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The WorkItem field slice (design 2026-09-03 §4, wave 2).
 *
 * There is no component test runner in this repo, so the behaviours the wave
 * plan asks for as component tests are pinned here instead: the action-center
 * keyboard order, the armed-row guard, the stale-cache marker, and a
 * forbidden command rendered as a disabled control that states its reason.
 *
 * Every assertion drives the real page against a mocked `/work/*` response,
 * so a change to the projection contract fails here rather than in the yard.
 */

test.describe.configure({ mode: "serial" });

const APIARY = "11111111-1111-1111-1111-111111111111";
const HIVE_A = "22222222-2222-2222-2222-222222222222";
const HIVE_B = "33333333-3333-3333-3333-333333333333";
const FEEDING = "44444444-4444-4444-4444-444444444444";
const REC = "55555555-5555-5555-5555-555555555555";
const SESSION = "66666666-6666-6666-6666-666666666666";

const AS_OF = "2026-09-03T12:00:00Z";

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

/**
 * Three items whose server order is fixed: the urgent feeder (rank 1), the
 * high recommendation (rank 2), then the harvest-ready hive (rank 5). The
 * keyboard order under test is exactly this order.
 */
function items(recOverrides: CommandOverrides = {}) {
  return [
    {
      id: `wi:feeding:${FEEDING}`,
      sourceType: "feeding",
      sourceId: FEEDING,
      context: {
        apiaryId: APIARY,
        apiaryName: "North Ridge",
        hiveId: HIVE_A,
        hiveName: "A3",
        locationId: null,
      },
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
        command(
          "feeding.close",
          "Verify and close",
          "POST",
          `/api/v1/feedings/${FEEDING}/close`,
          "c",
        ),
      ],
      sortRank: 1,
    },
    {
      id: `wi:recommendation:${REC}`,
      sourceType: "recommendation",
      sourceId: REC,
      context: {
        apiaryId: APIARY,
        apiaryName: "North Ridge",
        hiveId: HIVE_B,
        hiveName: "B1",
        locationId: null,
      },
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
        command(
          "recommendation.snooze",
          "Snooze",
          "POST",
          `/api/v1/recommendations/${REC}/snooze`,
          "s",
          recOverrides,
        ),
      ],
      sortRank: 2,
    },
    {
      id: `wi:harvest_ready:${HIVE_A}:${SESSION}`,
      sourceType: "harvest_ready",
      sourceId: SESSION,
      context: {
        apiaryId: APIARY,
        apiaryName: "North Ridge",
        hiveId: HIVE_A,
        hiveName: "A3",
        locationId: null,
      },
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

function todayBody(recOverrides: CommandOverrides = {}) {
  const all = items(recOverrides);
  const attention = all.filter((item) => item.sortRank <= 2);
  const today = all.filter((item) => item.sortRank > 2);
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    counts: { attention: attention.length, today: today.length, snoozed: 0 },
    groups: [
      { key: "attention", label: "Needs attention", items: attention },
      { key: "today", label: "Today's field actions", items: today },
    ],
  };
}

function yardBody() {
  return {
    asOf: AS_OF,
    freshness: serverFreshness(),
    yards: [
      {
        apiaryId: APIARY,
        apiaryName: "North Ridge",
        counts: { urgent: 1, high: 1, normal: 1 },
        items: items(),
      },
      {
        apiaryId: null,
        apiaryName: "All yards",
        counts: { urgent: 0, high: 0, normal: 0 },
        items: [],
      },
    ],
  };
}

interface MockOptions {
  /** Serve the work responses with the service worker's stale marker. */
  stale?: boolean;
  /** Overrides applied to the recommendation's commands. */
  recOverrides?: CommandOverrides;
  /** Called for every non-work mutation the page issues. */
  onCommand?: (route: Route) => void;
  /** Make the work reads fail, to exercise the error state. */
  failWork?: boolean;
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
          displayName: "Work test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Work test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }

    if (path.endsWith("/work/today") || path.endsWith("/work/yard")) {
      if (options.failWork) {
        return route.fulfill({
          status: 500,
          json: { error: "database error" },
        });
      }
      const status = url.searchParams.get("status") ?? "";
      // The triage filter (status widened to snoozed/dismissed) is a
      // different read; keep it empty so no undo is offered by default.
      const body = status.includes("dismissed")
        ? {
            asOf: AS_OF,
            freshness: serverFreshness(),
            counts: { attention: 0, today: 0, snoozed: 0 },
            groups: [
              { key: "attention", label: "Needs attention", items: [] },
              { key: "today", label: "Today's field actions", items: [] },
            ],
          }
        : path.endsWith("/work/today")
          ? todayBody(options.recOverrides)
          : yardBody();
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

    if (request.method() !== "GET") {
      options.onCommand?.(route);
      return route.fulfill({ json: { ok: true } });
    }

    // Anything else this shell asks for (labor control, incidents, …).
    return route.fulfill({ json: [] });
  });
}

test("Today renders the two server groups in the server's order", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/today");

  const sections = page.getByTestId("work-section");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toContainText("Needs attention");
  await expect(sections.nth(1)).toContainText("Today's field actions");

  // The client does not re-derive the split; it renders what the server sent.
  await expect(page.getByTestId("work-item")).toHaveCount(3);
  await expect(page.getByTestId("work-item-title")).toHaveText([
    "Verify and close",
    "Inspect this hive",
    "Pull honey",
  ]);
});

test("the yard queue is the same items grouped by apiary", async ({ page }) => {
  await mockApp(page);
  await page.goto("/yard/queue");

  await expect(page.getByTestId("work-section")).toHaveCount(2);
  await expect(page.getByTestId("work-item")).toHaveCount(3);
  await expect(page.getByTestId("work-item-title")).toHaveText([
    "Verify and close",
    "Inspect this hive",
    "Pull honey",
  ]);
});

test("arrow keys walk the rendered order and the armed-row guard holds", async ({
  page,
}) => {
  const commands: string[] = [];
  await mockApp(page, {
    onCommand: (route) => commands.push(new URL(route.request().url()).pathname),
  });
  await page.goto("/today");
  await expect(page.getByTestId("work-item")).toHaveCount(3);

  // A letter before any arrow movement must not fire: no row is armed yet.
  await page.locator("body").press("d");
  await page.waitForTimeout(250);
  expect(commands).toEqual([]);

  // ArrowDown lands on the first item in the server's order.
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByTestId("work-item").nth(0),
  ).toHaveAttribute("data-source-type", "feeding");
  await expect(page.getByTestId("work-item").nth(0)).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("work-item").nth(1)).toBeFocused();

  // The focused row's own key runs the focused row's own command — the
  // recommendation's `d`, not the feeder's.
  await page.keyboard.press("d");
  await expect
    .poll(() => commands)
    .toEqual([`/api/v1/recommendations/${REC}/dismiss`]);
  // Letters stand down while a command is still running (busy guard), so
  // wait for the dismiss receipt to settle before the next key.
  await expect(page.getByTestId("work-receipt")).toHaveAttribute(
    "data-phase",
    "done",
  );

  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("work-item").nth(0)).toBeFocused();
  await page.keyboard.press("r");
  await expect
    .poll(() => commands)
    .toEqual([
      `/api/v1/recommendations/${REC}/dismiss`,
      `/api/v1/feedings/${FEEDING}/refill`,
    ]);
});

test("a command runs its own source path, with a command-bound mutation id", async ({
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
  await page.goto("/today");

  await page
    .getByTestId("work-command")
    .filter({ hasText: "Refill" })
    .click();

  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0].method).toBe("POST");
  // Not a generic work-item mutation: the feeding's own refill endpoint.
  expect(seen[0].path).toBe(`/api/v1/feedings/${FEEDING}/refill`);
  expect(seen[0].mutationId).toContain("feeding.refill");
  expect(seen[0].mutationId).not.toContain("{clientMutationId}");

  await expect(page.getByTestId("work-receipt")).toHaveAttribute(
    "data-phase",
    "done",
  );
});

test("a stale cached response is rendered as stale", async ({ page }) => {
  await mockApp(page, { stale: true });
  await page.goto("/today");

  const freshness = page.getByTestId("work-freshness");
  await expect(freshness).toHaveAttribute("data-state", "stale");
  await expect(freshness).toContainText("Stale");
});

test("a live response is not marked stale", async ({ page }) => {
  await mockApp(page);
  await page.goto("/today");

  const freshness = page.getByTestId("work-freshness");
  await expect(freshness).toHaveAttribute("data-state", "server");
  await expect(freshness).toContainText("Live");
});

test("a forbidden command is disabled and states its reason", async ({
  page,
}) => {
  const commands: string[] = [];
  await mockApp(page, {
    recOverrides: {
      permitted: false,
      deniedReason: "editor access on North Ridge is required",
    },
    onCommand: (route) => commands.push(new URL(route.request().url()).pathname),
  });
  await page.goto("/today");

  const dismiss = page
    .getByTestId("work-command")
    .filter({ hasText: "Dismiss" });
  await expect(dismiss).toBeDisabled();
  await expect(dismiss).toHaveAttribute("data-blocked", "forbidden");
  // The reason is visible, not only a tooltip: a disabled control that does
  // not say why is indistinguishable from a broken one.
  await expect(
    page.getByTestId("work-command-reason").filter({ hasText: "Dismiss" }),
  ).toContainText("editor access on North Ridge is required");

  // And the keyboard must refuse it too, not just the button.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("d");
  await expect(page.getByTestId("work-receipt")).toHaveAttribute(
    "data-phase",
    "error",
  );
  expect(commands).toEqual([]);
});

test("an online-only command is disabled while offline, with its reason", async ({
  page,
  context,
}) => {
  await mockApp(page);
  await page.goto("/today");
  await expect(page.getByTestId("work-item")).toHaveCount(3);

  await context.setOffline(true);
  // The page listens for the browser's own offline event.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await expect(page.getByTestId("work-connection")).toHaveAttribute(
    "data-state",
    "offline",
  );

  const start = page
    .getByTestId("work-command")
    .filter({ hasText: "Start extraction day" });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("data-blocked", "offline");
  await expect(
    page
      .getByTestId("work-command-reason")
      .filter({ hasText: "Start extraction day" }),
  ).toContainText("not in the offline queue manifest");

  // A queueable command stays pressable and says it will queue.
  await expect(
    page.getByTestId("work-command").filter({ hasText: "Refill" }),
  ).toBeEnabled();

  await context.setOffline(false);
});

test("a queued mutation is neither a success nor a failure", async ({
  page,
}) => {
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
          displayName: "Work test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Work test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/work/today")) {
      return route.fulfill({ json: todayBody() });
    }
    if (request.method() !== "GET") {
      // Exactly the receipt the service worker returns when it queues a
      // mutation for replay (sw.js/route.ts:523).
      return route.fulfill({
        status: 202,
        json: { queued: true, offline: true, mutationId: "queued-1" },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/today");

  await page.getByTestId("work-command").filter({ hasText: "Refill" }).click();

  const receipt = page.getByTestId("work-receipt");
  await expect(receipt).toHaveAttribute("data-phase", "queued");
  await expect(receipt).toContainText("queued offline");
  await expect(receipt).toContainText("has not been applied yet");
});

test("a failed read is an error state, not an empty list", async ({ page }) => {
  await mockApp(page, { failWork: true });
  await page.goto("/today");

  await expect(page.getByTestId("work-error")).toBeVisible();
  await expect(page.getByTestId("work-empty")).toHaveCount(0);
});

test("the recommendation filter is the same shape under a different filter", async ({
  page,
}) => {
  const reads: string[] = [];
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
          displayName: "Work test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Work test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/work/today")) {
      reads.push(url.search);
      const all = items();
      const recs = all.filter((item) => item.sourceType === "recommendation");
      return route.fulfill({
        json: {
          asOf: AS_OF,
          freshness: serverFreshness(),
          counts: { attention: recs.length, today: 0, snoozed: 0 },
          groups: [
            { key: "attention", label: "Needs attention", items: recs },
            { key: "today", label: "Today's field actions", items: [] },
          ],
        },
      });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto("/today/recommendations");
  await expect(page.getByTestId("work-item")).toHaveCount(1);

  // One endpoint, one shape, three filters (§4.8): this surface differs from
  // Today only by its query string.
  expect(reads.some((search) => search.includes("sourceType=recommendation"))).toBe(
    true,
  );
  expect(
    reads.some((search) => search.includes("status=open%2Csnoozed%2Cdismissed")),
  ).toBe(true);
});

/**
 * Offline navigation to `/today` from the service-worker shell.
 *
 * Wave 2 wrote this assertion against the shell as it would be and skipped it
 * while `SHELL` still named the legacy field routes. Wave 5 rewrote `SHELL`,
 * so the self-skip is gone and the assertion is live: the two canonical field
 * routes must be precached, or an offline navigation to Today falls through
 * to `/offline`.
 */
test("the SHELL precache includes the canonical field routes", async ({
  request,
}) => {
  const response = await request.get("/sw.js");
  const sw = await response.text();
  expect(sw).toContain('"/today"');
  expect(sw).toContain('"/yard/queue"');
});
