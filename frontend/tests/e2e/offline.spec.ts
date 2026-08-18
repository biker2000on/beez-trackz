import { expect, test } from "@playwright/test";

const honeyCommercePaths = [
  "/api/v1/harvests",
  "/api/v1/honey/jarring",
  "/api/v1/honey/bulk-movements",
  "/api/v1/honey/give-away",
  "/api/v1/honey/jar-adjustments",
  "/api/v1/honey/movements/",
  "/api/v1/honey/sales",
  "/api/v1/jar-sizes",
  "/api/v1/expenses",
  "/api/v1/customers",
  "/api/v1/harvest-lots",
  "/api/v1/wholesale-price-lists",
];

test("service worker source encodes offline queue contracts", async ({
  request,
}) => {
  const response = await request.get("/sw.js");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("javascript");
  const sw = await response.text();

  expect(sw).not.toContain("${");
  expect(sw.trimStart().startsWith("const SHELL_CACHE")).toBeTruthy();

  const replay = sw.slice(
    sw.indexOf("async function replayQueue"),
    sw.indexOf("function queueableBody"),
  );
  expect(replay).toContain("needsAuth = true");
  expect(replay).toContain("await saveQueueItem(item)");
  expect(replay).toMatch(/status === 401 \|\| response\.status === 403/);
  expect(replay).toContain('errorBody?.error?.includes("already processing")');
  expect(replay).not.toMatch(
    /already processing"\s*\)\s*\{[^}]*\bbreak\b/,
  );
  expect(replay).toContain("receiptExpired");
  expect(replay).toContain("older than 30 days");

  const logout = sw.slice(
    sw.indexOf("async function clearPrivateOfflineState"),
    sw.indexOf("function summarizeQueueItem"),
  );
  expect(logout).toContain("caches.delete(DATA_CACHE)");
  expect(logout).not.toContain("clearQueue");

  for (const path of honeyCommercePaths) {
    expect(sw).toContain('"' + path + '"');
  }
  expect(sw).toContain('"/api/v1/canvas/hives"');
  expect(sw).toContain('"/api/v1/harvest-sessions"');
  expect(sw).toContain('"/api/v1/recommendations/run"');

  const retry = sw.slice(
    sw.indexOf('event.data?.type === "RETRY_OFFLINE_MUTATION"'),
    sw.indexOf('event.data?.type === "DISCARD_OFFLINE_MUTATION"'),
  );
  expect(retry).toContain("retriedAt");
  expect(retry).not.toContain("queuedAt =");

  expect(sw).toContain('"/login"');
  expect(sw).toContain('"/dashboard"');
  expect(sw).toContain('"/operations/yard-queue"');
  expect(sw).toContain('"/harvest"');
  expect(sw).toContain('"/harvest/market-day"');
  expect(sw).toContain("function navigateFallback");
  expect(sw).toContain("caches.match(url.pathname)");

  const queueable = sw.slice(
    sw.indexOf("function queueableBody"),
    sw.indexOf("function cacheableAPI"),
  );
  expect(queueable).toContain("if (!contentType) return true");
  expect(queueable).toContain("application/json");

  expect(sw).toContain('headers.set("X-Beez-Cache", "stale")');
  expect(sw).toContain("const MAX_QUEUE_ITEMS = 200");
  expect(sw).toContain("const DATA_CACHE_LIMIT = 200");
  expect(sw).toContain("const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000");
  expect(sw).toContain("async function putDataCache");
});
