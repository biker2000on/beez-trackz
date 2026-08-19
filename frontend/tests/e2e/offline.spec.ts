import { expect, test } from "@playwright/test";

import { OFFLINE_ROUTE_MANIFEST } from "../../src/lib/offline-routes.generated";

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

  // The queueable route list is generated from the Go middleware's manifest
  // (backend/internal/httpapi/offline_routes.go). Assert the served worker
  // carries that exact manifest, so a route added on one side of the seam
  // cannot silently miss the other.
  expect(sw).toContain(
    "const OFFLINE_ROUTES = " + JSON.stringify(OFFLINE_ROUTE_MANIFEST) + ";",
  );
  expect(sw).toContain("function offlineRouteSupported");

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
