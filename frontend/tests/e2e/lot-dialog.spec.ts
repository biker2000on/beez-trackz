import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * The "Create harvest lot" dialog fills itself in from the yard.
 *
 * Yard + frames-pulled date + extraction date are the whole question; season,
 * region, elevation, year, bloom notes, varietal and the source harvests are
 * answers the yard already holds (`GET /lots/prefill`), and the beekeeper
 * story can be drafted from the season's logs (`POST /lots/story-draft`).
 *
 * Every `/api/v1/**` read is `page.route`-mocked to the API's shapes, the way
 * `journeys.spec.ts` does it: the shape is the contract, and this spec must
 * fail when the contract moves rather than when a database is empty.
 */

test.describe.configure({ mode: "serial" });

const NORTH = "11111111-aaaa-4aaa-8aaa-111111111111";
const SOUTH = "12121212-aaaa-4aaa-8aaa-121212121212";
const HIVE = "22222222-bbbb-4bbb-8bbb-222222222222";
const SESSION = "55555555-eeee-4eee-8eee-555555555555";
const OTHER_LOT = "66666666-ffff-4fff-8fff-666666666666";
const SOURWOOD = "99999999-0000-4000-8000-999999999999";
const CLOVER = "99999999-0000-4000-8000-999999999998";

const harvest = (
  id: string,
  apiaryName: string,
  hiveName: string,
  date: string,
  lbs: number,
) => ({
  id,
  hiveId: HIVE,
  sessionId: SESSION,
  date,
  superWeightBefore: lbs + 20,
  superWeightAfter: 20,
  calculatedHoneyWeight: lbs,
  directWeight: false,
  notes: null,
  hiveName,
  apiaryName,
});

/** Five harvests in two yards; the August ones at North Ridge are the pull. */
const HARVESTS = [
  harvest("h-a3", "North Ridge", "A3", "2026-08-20", 42.5),
  harvest("h-a4", "North Ridge", "A4", "2026-08-20", 38),
  harvest("h-a5", "North Ridge", "A5", "2026-08-21", 30),
  harvest("h-b1", "North Ridge", "B1", "2026-06-10", 25),
  harvest("h-s1", "South Meadow", "S1", "2026-08-19", 19),
];

function prefillFor(apiaryId: string, pulledOn: string) {
  const north = apiaryId === NORTH;
  return {
    season: north ? "Late summer 2026" : "Spring 2026",
    claimYear: 2026,
    apiaryRegion: north ? "Western New York" : "Finger Lakes",
    elevationM: north ? 640.08 : 200,
    bloomNotes: north
      ? "Goldenrod opening along the north fence; knapweed fading."
      : "Black locust just finished.",
    suggestedVarietalId: north ? SOURWOOD : CLOVER,
    harvests: HARVESTS.map((row) => ({
      id: row.id,
      hiveId: row.hiveId,
      hiveName: row.hiveName,
      sessionId: row.sessionId,
      date: row.date,
      calculatedHoneyWeight: row.calculatedHoneyWeight,
      directWeight: row.directWeight,
      inLotId: row.id === "h-a5" ? OTHER_LOT : null,
      suggested: north && row.date >= pulledOn && row.apiaryName === "North Ridge",
    })),
  };
}

interface MockOptions {
  /** Answer the story draft with the no-provider 503. */
  noProvider?: boolean;
}

async function mockApp(page: Page, options: MockOptions = {}) {
  const prefillRequests: URL[] = [];
  const storyRequests: Request[] = [];
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
          displayName: "Lot test",
          isAdmin: true,
        },
      });
    }
    if (path.endsWith("/access/me")) {
      return route.fulfill({
        json: {
          id: "user-1",
          displayName: "Lot test",
          email: null,
          isAdmin: true,
          memberships: [],
        },
      });
    }
    if (path.endsWith("/ops/units")) {
      return route.fulfill({ json: { units: "us", temperatureUnit: "f" } });
    }
    if (path.endsWith("/apiaries")) {
      return route.fulfill({
        json: [
          { id: NORTH, name: "North Ridge" },
          { id: SOUTH, name: "South Meadow" },
        ],
      });
    }
    if (path.endsWith("/honey/varietals")) {
      return route.fulfill({
        json: [
          { id: SOURWOOD, name: "Sourwood", lotCount: 0, lotLbs: 0 },
          { id: CLOVER, name: "Clover", lotCount: 0, lotLbs: 0 },
        ],
      });
    }
    if (path.endsWith("/harvests")) {
      return route.fulfill({ json: HARVESTS });
    }
    if (path.endsWith("/harvest-lots")) {
      return route.fulfill({ json: [] });
    }
    if (path.endsWith("/lots/prefill")) {
      prefillRequests.push(url);
      return route.fulfill({
        json: prefillFor(
          url.searchParams.get("apiaryId") ?? "",
          url.searchParams.get("pulledOn") ?? "",
        ),
      });
    }
    if (path.endsWith("/lots/story-draft")) {
      storyRequests.push(request);
      if (options.noProvider) {
        return route.fulfill({
          status: 503,
          json: { error: "no AI provider is configured" },
        });
      }
      return route.fulfill({
        json: {
          story:
            "The August pull came off three hives on the north ridge after a dry goldenrod flow.",
          provider: "mock",
          sources: { inspections: 7, harvests: 3, bloomObservations: 2, weatherDays: 14 },
        },
      });
    }

    if (request.method() !== "GET") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: [] });
  });
  return { prefillRequests, storyRequests };
}

async function openCreateDialog(page: Page) {
  await page.goto("/production/lots");
  await page.getByRole("button", { name: "New harvest lot" }).click();
  const dialog = page.getByRole("dialog", { name: "Create harvest lot" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function pickYard(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Yard" }).click();
  await page.getByRole("option", { name }).click();
}

test("yard and dates fill the season, claim and harvests from the yard's notes", async ({
  page,
}) => {
  const { prefillRequests } = await mockApp(page);
  const dialog = await openCreateDialog(page);

  // Nothing is asked of the yard until all three inputs are set.
  await dialog.getByLabel("Extraction date").fill("2026-08-22");
  await pickYard(page, "North Ridge");
  await page.waitForTimeout(500);
  expect(prefillRequests).toHaveLength(0);
  await expect(dialog.getByTestId("auto-hint")).toHaveCount(0);

  await dialog.getByLabel("Frames pulled").fill("2026-08-20");
  await expect.poll(() => prefillRequests.length).toBe(1);
  expect(Object.fromEntries(prefillRequests[0].searchParams)).toEqual({
    apiaryId: NORTH,
    pulledOn: "2026-08-20",
    extractedOn: "2026-08-22",
  });

  await expect(dialog.getByLabel("Season")).toHaveValue("Late summer 2026");
  await expect(dialog.getByLabel("Approximate region")).toHaveValue("Western New York");
  // 640.08 m, shown in the operator's own units.
  await expect(dialog.getByLabel("Elevation")).toHaveValue("2100 ft");
  await expect(dialog.getByLabel("Year")).toHaveValue("2026");
  await expect(dialog.getByLabel("Bloom observations")).toHaveValue(
    "Goldenrod opening along the north fence; knapweed fading.",
  );
  await expect(page.getByRole("combobox", { name: "Varietal" })).toContainText("Sourwood");
  // Season, region, elevation, year, bloom and varietal each say where they came from.
  await expect(dialog.getByTestId("auto-hint")).toHaveCount(6);

  // The pull window's harvests are ticked; the one another lot already claims
  // is shown but cannot be taken, and the derived weight follows the ticks.
  const options = dialog.getByTestId("lot-harvest-option");
  await expect(options).toHaveCount(3);
  await expect(dialog.getByRole("checkbox", { name: /A3/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /A4/ })).toBeChecked();
  const claimed = dialog.getByRole("checkbox", { name: /A5/ });
  await expect(claimed).toBeDisabled();
  await expect(claimed).not.toBeChecked();
  await expect(options.filter({ hasText: "A5" })).toContainText("already in a lot");
  await expect(dialog.getByText("derived from 2 harvests")).toBeVisible();

  // The claim fieldset no longer asks for a species: the varietal is it.
  await expect(dialog.getByLabel("Species or blend")).toHaveCount(0);
  await expect(dialog.getByText("The claim species is the varietal above")).toBeVisible();
});

test("a field the operator typed in is never overwritten by a later prefill", async ({
  page,
}) => {
  const { prefillRequests } = await mockApp(page);
  const dialog = await openCreateDialog(page);

  await dialog.getByLabel("Approximate region").fill("Bristol Hills");
  await dialog.getByLabel("Extraction date").fill("2026-08-22");
  await dialog.getByLabel("Frames pulled").fill("2026-08-20");
  await pickYard(page, "North Ridge");
  await expect.poll(() => prefillRequests.length).toBe(1);
  await expect(dialog.getByLabel("Season")).toHaveValue("Late summer 2026");
  await expect(dialog.getByLabel("Approximate region")).toHaveValue("Bristol Hills");

  // Editing an auto value takes it over: the hint goes, and the next prefill
  // leaves it alone while still refreshing the untouched fields.
  await dialog.getByLabel("Bloom observations").fill("Basswood, not goldenrod.");
  // B1 is June, so it sits behind the toggle until the operator ticks it.
  await dialog.getByRole("button", { name: "Show all 5 harvests" }).click();
  await dialog.getByRole("checkbox", { name: /B1/ }).check();
  await dialog.getByRole("button", { name: "Show fewer" }).click();
  await pickYard(page, "South Meadow");
  await expect.poll(() => prefillRequests.length).toBe(2);
  await expect(dialog.getByLabel("Season")).toHaveValue("Spring 2026");
  await expect(dialog.getByLabel("Approximate region")).toHaveValue("Bristol Hills");
  await expect(dialog.getByLabel("Bloom observations")).toHaveValue(
    "Basswood, not goldenrod.",
  );
  // Season, elevation, year and varietal follow the new yard; the operator
  // owns region and bloom now.
  await expect(page.getByRole("combobox", { name: "Varietal" })).toContainText("Clover");
  await expect(dialog.getByTestId("auto-hint")).toHaveCount(4);
  // The operator's tick survives; the first yard's suggestions do not.
  await expect(dialog.getByRole("checkbox", { name: /B1/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /A3/ })).toHaveCount(0);
});

test("the harvest list expands in place instead of scrolling", async ({ page }) => {
  const { prefillRequests } = await mockApp(page);
  const dialog = await openCreateDialog(page);
  const options = dialog.getByTestId("lot-harvest-option");

  // Nothing suggested yet: the list is collapsed behind one toggle.
  await expect(options).toHaveCount(0);
  await expect(dialog.getByText("0 of 5 selected")).toBeVisible();
  const toggle = dialog.getByRole("button", { name: "Show all 5 harvests" });
  await toggle.click();
  await expect(options).toHaveCount(5);
  // Two yards are present, so the rows are grouped by yard.
  await expect(
    dialog.getByTestId("lot-harvests").getByText("South Meadow", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Show fewer" }).click();
  await expect(options).toHaveCount(0);

  // After a prefill the suggested rows are the collapsed view; the rest stay
  // one click away, and nothing inside the dialog scrolls on its own.
  await dialog.getByLabel("Extraction date").fill("2026-08-22");
  await dialog.getByLabel("Frames pulled").fill("2026-08-20");
  await pickYard(page, "North Ridge");
  await expect.poll(() => prefillRequests.length).toBe(1);
  await expect(options).toHaveCount(3);
  await dialog.getByRole("button", { name: "Show all 5 harvests" }).click();
  await expect(options).toHaveCount(5);
  await expect(
    dialog.getByTestId("lot-harvests").locator(".overflow-y-auto"),
  ).toHaveCount(0);
});

test("Draft with AI writes the story and says what it was drafted from", async ({
  page,
}) => {
  const { storyRequests } = await mockApp(page);
  const dialog = await openCreateDialog(page);
  const draft = dialog.getByRole("button", { name: "Draft with AI" });

  await expect(draft).toBeDisabled();
  await dialog.getByLabel("Extraction date").fill("2026-08-22");
  await dialog.getByLabel("Frames pulled").fill("2026-08-20");
  await pickYard(page, "North Ridge");
  await expect(draft).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: /A3/ })).toBeChecked();

  await draft.click();
  await expect(dialog.getByLabel("Beekeeper story")).toHaveValue(
    /The August pull came off three hives/,
  );
  await expect(dialog.getByTestId("story-draft-sources")).toHaveText(
    "AI draft from 7 inspections, 3 harvests, 2 bloom notes — edit before publishing",
  );
  expect(storyRequests).toHaveLength(1);
  expect(storyRequests[0].postDataJSON()).toEqual({
    apiaryId: NORTH,
    pulledOn: "2026-08-20",
    extractedOn: "2026-08-22",
    varietalId: SOURWOOD,
    harvestIds: ["h-a3", "h-a4"],
  });

  // A story already written is only replaced on purpose.
  page.once("dialog", (confirm) => void confirm.dismiss());
  await dialog.getByLabel("Beekeeper story").fill("My own words.");
  await draft.click();
  await expect(dialog.getByLabel("Beekeeper story")).toHaveValue("My own words.");
  expect(storyRequests).toHaveLength(1);
});

test("without an AI provider the draft button says where to configure one", async ({
  page,
}) => {
  await mockApp(page, { noProvider: true });
  const dialog = await openCreateDialog(page);

  await dialog.getByLabel("Extraction date").fill("2026-08-22");
  await dialog.getByLabel("Frames pulled").fill("2026-08-20");
  await pickYard(page, "North Ridge");
  await dialog.getByRole("button", { name: "Draft with AI" }).click();

  await expect(
    page.getByText("No AI provider is configured. Add one under Admin, then draft again."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Beekeeper story")).toHaveValue("");
  await expect(dialog.getByTestId("story-draft-sources")).toHaveCount(0);
});
