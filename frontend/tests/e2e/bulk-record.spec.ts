import { test, expect, type Page } from "@playwright/test";

const HIVES = [
  { id: "h1", apiaryId: "a1", positionLabel: "A1", status: "active", isArchived: false, installedDate: "2025-04-13", deadoutDate: null },
  { id: "h2", apiaryId: "a1", positionLabel: "A2", status: "active", isArchived: false, installedDate: "2025-04-13", deadoutDate: null },
  // A retired colony that used to stand at A2: never offered. The active A2
  // still reads as its bare label.
  { id: "h0", apiaryId: "a1", positionLabel: "A2", status: "dead", isArchived: true, installedDate: "2024-05-01", deadoutDate: "2025-03-01" },
];

async function mockBulk(page: Page) {
  const posts: { path: string; body: Record<string, unknown>; mutationId: string | null }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/status")) return route.fulfill({ json: { authenticated: true, setupComplete: true } });
    if (path.endsWith("/access/me")) return route.fulfill({ json: { id: "user-bulk", isAdmin: true, displayName: "Bulk test", memberships: [] } });
    if (path.endsWith("/apiaries/a1")) return route.fulfill({ json: { id: "a1", name: "North yard" } });
    if (path.endsWith("/hives")) return route.fulfill({ json: HIVES });
    if (path.endsWith("/treatment-products"))
      return route.fulfill({ json: [{ id: "p1", name: "Oxalic acid", aliases: ["oxalic"], withdrawalDays: 0, notes: "One-shot: set date_removed to the application date." }] });
    if (request.method() === "POST" && (path.endsWith("/treatment-events") || path.endsWith("/mite-counts"))) {
      posts.push({ path, body: request.postDataJSON(), mutationId: request.headers()["x-offline-mutation-id"] ?? null });
      return route.fulfill({ status: 201, json: { id: `rec-${posts.length}` } });
    }
    return route.fulfill({ json: [] });
  });
  return posts;
}

test("Bulk treatment series saves one record per hive per date and ends one-shot treatments", async ({ page }) => {
  const posts = await mockBulk(page);
  await page.goto("/yard/apiaries/a1/bulk");
  await expect(page.getByRole("button", { name: "A2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose all 2" }).click();
  await page.getByRole("radio", { name: "Treatment" }).check();
  await page.getByLabel("Product").fill("Oxalic acid");
  await page.getByLabel("Date 1").fill("2026-11-01");
  await page.getByRole("button", { name: "Add the next date" }).click();
  await expect(page.getByLabel("Date 2")).toHaveValue("2026-11-06");
  await expect(page.getByRole("checkbox", { name: /ends the same day/ })).toBeChecked();
  await page.getByRole("button", { name: "Save 4 treatment records" }).click();
  await expect.poll(() => posts.length).toBe(4);
  for (const post of posts) {
    expect(post.path).toContain("/treatment-events");
    expect(post.body.dateRemoved).toBe(post.body.dateApplied);
    expect(post.mutationId).toBeTruthy();
  }
  expect(new Set(posts.map((post) => `${post.body.hiveId}|${post.body.dateApplied}`)).size).toBe(4);
});

test("Bulk mite count sends each hive's own count with the shared sample size", async ({ page }) => {
  const posts = await mockBulk(page);
  await page.goto("/yard/apiaries/a1/bulk");
  await page.getByRole("button", { name: "Choose all 2" }).click();
  await page.getByRole("radio", { name: "Mite count" }).check();
  await expect(page.getByLabel("Bees sampled")).toHaveValue("300");
  await page.getByRole("textbox", { name: "A1", exact: true }).fill("3");
  await page.getByRole("button", { name: "Save 1 mite count" }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].body).toMatchObject({ hiveId: "h1", method: "alcohol_wash", mitesCount: 3, sampleSize: 300 });
});
