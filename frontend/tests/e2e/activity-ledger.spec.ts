import { expect, test, type Page } from "@playwright/test";

// The Activity ledger: keyset-paged infinite scroll and desktop selection
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
}

// Newest first, three entries a day, so pages cross day groups.
const ENTRIES: MockEntry[] = Array.from({ length: TOTAL }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 9) - Math.floor(i / 3) * 86_400_000);
  return {
    id: `e${String(i + 1).padStart(3, "0")}`,
    date: day.toISOString(),
    type: i % 2 === 0 ? "jarring" : "jar_adjustment",
    description: `Entry ${i + 1}`,
    amountLbs: null,
    quantity: i % 2 === 0 ? 4 : -1,
    totalAmount: null,
    notes: null,
    isReversal: false,
    reversesMovementId: null,
    cancelled: false,
  };
});

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
    if (path.endsWith("/honey/activity")) {
      activityRequests.push(url);
      // The cursor is opaque to the client; the mock uses an offset.
      const offset = Number(url.searchParams.get("cursor") || "0");
      const limit = Number(url.searchParams.get("limit") || "50");
      const type = url.searchParams.get("type");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const rows = ENTRIES.filter(
        (entry) =>
          (!type || type.split(",").includes(entry.type)) &&
          (!q || entry.description.toLowerCase().includes(q)),
      );
      const slice = rows.slice(offset, offset + limit);
      const next = offset + limit < rows.length ? String(offset + limit) : null;
      return route.fulfill({ json: { entries: slice, nextCursor: next } });
    }
    return route.fulfill({ json: [] });
  });
}

const rows = (page: Page) => page.locator("tbody tr[data-grid-row]");
const row = (page: Page, index: number) => rows(page).nth(index);
/** Click a row on its Kind cell (never on a link or the action button). */
const clickRow = (
  page: Page,
  index: number,
  modifiers?: ("Shift" | "ControlOrMeta")[],
) => row(page, index).locator("td").nth(1).click({ modifiers });

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

test("activity loads more pages as the end of the ledger scrolls into view", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/production/activity");

  await expect(rows(page)).toHaveCount(50);
  await expect(page.getByText("Entry 1", { exact: true })).toBeVisible();

  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(TOTAL);
  await expect(page.getByText(`End of ledger · ${TOTAL} entries`)).toBeVisible();

  // Each page asked for the next cursor, never the same one twice.
  const cursors = requests.map((url) => url.searchParams.get("cursor") ?? "");
  expect(cursors).toEqual(["", "50", "100"]);
});

test("filters are sent to the server and kept across pages", async ({ page }) => {
  const requests: URL[] = [];
  await mockApp(page, requests);
  await page.goto("/production/activity");
  await expect(rows(page)).toHaveCount(50);

  await page
    .getByRole("group", { name: "Filter by kind" })
    .getByRole("button", { name: "Jarring" })
    .click();
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

  await page.getByRole("searchbox", { name: "Search activity" }).fill("Entry 11");
  await expect(page).toHaveURL(/q=Entry\+11|q=Entry%2011/);
  // "entry 11" matches 11 and 110-119; the jarring ones are 11, 111, 113, 115, 117, 119.
  await expect(rows(page)).toHaveCount(6);
  expect(
    requests.some(
      (url) =>
        url.searchParams.get("q") === "Entry 11" &&
        url.searchParams.get("type") === "jarring",
    ),
  ).toBe(true);
});

test("click, shift-click and ctrl-click follow desktop selection conventions", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/activity");
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

test("a shift-click range spans loaded pages and survives loading more", async ({
  page,
}) => {
  await mockApp(page);
  await page.goto("/production/activity");
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
  await page.goto("/production/activity");
  await expect(rows(page)).toHaveCount(50);

  await clickRow(page, 2);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await expectSelected(page, [2, 3, 4]);
  await page.keyboard.press("Shift+ArrowUp");
  await expectSelected(page, [2, 3]);
  await page.keyboard.press("Escape");

  await page.getByRole("checkbox", { name: "Select all loaded activity rows" }).click();
  await expect(page.getByText("50 loaded rows selected", { exact: true })).toBeVisible();

  // Rows loaded afterwards are not silently added to the selection.
  await scrollToEnd(page);
  await expect(rows(page)).toHaveCount(100);
  await expect(page.getByText("50 selected", { exact: true })).toBeVisible();
  await expect(row(page, 60)).toHaveAttribute("aria-selected", "false");
});

test("on a phone the ledger is cards that select by tap and checkbox, with select all above them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApp(page);
  await page.goto("/production/activity");

  const list = page.getByRole("list", { name: "Honey activity" });
  await expect(list).toBeVisible();
  await expect(page.getByRole("table", { name: "Honey activity" })).toHaveCount(0);
  const cards = list.locator("[data-grid-card]");
  await expect(cards).toHaveCount(50);
  /** Tap a card on its Amount label (never on a link or the action button). */
  const tapCard = (index: number) =>
    cards.nth(index).getByText("Amount", { exact: true }).click();

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
  await page.getByRole("checkbox", { name: "Select all loaded activity rows" }).click();
  await expect(page.getByText("50 loaded rows selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
});
