import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OFFLINE_ROUTE_MANIFEST } from "@/lib/offline-routes.generated";

// Interpolating the build id into the cache names gives every deploy a fresh
// cache generation, and activate() deletes the previous one. Stale API and
// static entries used to accumulate across deploys until the literal "-v2"
// suffix was bumped by hand.
function nextBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
}
const BUILD_ID = nextBuildId();

const serviceWorker = String.raw`
const SHELL_CACHE = "beez-trackz-shell-${BUILD_ID}";
const DATA_CACHE = "beez-trackz-api-${BUILD_ID}";
const OFFLINE_ROUTES = ${JSON.stringify(OFFLINE_ROUTE_MANIFEST)};
const QUEUE_DB = "beez-trackz-offline";
const QUEUE_STORE = "mutations";
const SHELL = [
  "/offline",
  "/login",
  "/dashboard",
  "/operations/yard-queue",
  "/honey",
  "/honey/market-day",
  "/sales",
  "/sales/market-day",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/apple-touch-icon.png",
];
const MAX_QUEUE_ITEMS = 200;
const DATA_CACHE_LIMIT = 200;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const QUEUE_FULL_ERROR = "offline queue is full";

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueRequest(request) {
  const database = await openQueue();
  const headers = {};
  request.headers.forEach((value, key) => {
    if (key !== "cookie" && key !== "authorization") headers[key] = value;
  });
  const id =
    request.headers.get("X-Offline-Mutation-ID") || crypto.randomUUID();
  headers["x-offline-mutation-id"] = id;
  const item = {
    id,
    url: request.url,
    method: request.method,
    headers,
    body: request.method === "DELETE" ? null : await request.clone().text(),
    queuedAt: new Date().toISOString(),
    state: "pending",
    error: null,
  };
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      const store = transaction.objectStore(QUEUE_STORE);
      let refused = false;
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const existing = allReq.result || [];
        if (existing.length >= MAX_QUEUE_ITEMS) {
          const failed = existing
            .filter((entry) => entry.state === "failed")
            .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
          const need = existing.length - MAX_QUEUE_ITEMS + 1;
          const dropped = failed.slice(0, need);
          for (const drop of dropped) store.delete(drop.id);
          if (existing.length - dropped.length >= MAX_QUEUE_ITEMS) {
            refused = true;
            transaction.abort();
            return;
          }
        }
        store.put(item);
      };
      allReq.onerror = () => reject(allReq.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () =>
        reject(refused ? new Error(QUEUE_FULL_ERROR) : transaction.error);
      transaction.onabort = () =>
        reject(refused ? new Error(QUEUE_FULL_ERROR) : transaction.error);
    });
  } finally {
    database.close();
  }
  await broadcastQueueStatus();
  return item;
}

async function queueItems() {
  const database = await openQueue();
  try {
    const items = await new Promise((resolve, reject) => {
      const request = database
        .transaction(QUEUE_STORE, "readonly")
        .objectStore(QUEUE_STORE)
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  } finally {
    database.close();
  }
}

async function saveQueueItem(item) {
  const database = await openQueue();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      transaction.objectStore(QUEUE_STORE).put(item);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function deleteQueueItem(id) {
  const database = await openQueue();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      transaction.objectStore(QUEUE_STORE).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function clearQueue() {
  const database = await openQueue();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(QUEUE_STORE, "readwrite");
      transaction.objectStore(QUEUE_STORE).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function clearPrivateOfflineState() {
  // Drop cached API/private reads only. The mutation queue must survive
  // logout the same way it survives login — a day of field work is still
  // sitting in IndexedDB and must replay after the next sign-in.
  await caches.delete(DATA_CACHE);
  await broadcastQueueStatus();
}

function summarizeQueueItem(item) {
  return {
    id: item.id,
    method: item.method,
    path: new URL(item.url).pathname,
    queuedAt: item.queuedAt,
    retriedAt: item.retriedAt || null,
    state: item.state,
    error: item.error,
    needsAuth: Boolean(item.needsAuth),
  };
}

async function broadcastQueueStatus() {
  const items = await queueItems();
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const pendingItems = items.filter((item) => item.state === "pending");
  const conflictItems = items.filter((item) => item.state === "conflict");
  const failedItems = items.filter((item) => item.state === "failed");
  // Review dialog only lists non-pending rows; send those plus counts
  // rather than every queued body.
  const detail = {
    pending: pendingItems.length,
    conflicts: conflictItems.length,
    failed: failedItems.length,
    needsAuth: items.some((item) => item.needsAuth),
    queueSize: items.length,
    queueLimit: MAX_QUEUE_ITEMS,
    items: conflictItems.concat(failedItems).map(summarizeQueueItem),
  };
  clients.forEach((client) =>
    client.postMessage({ type: "OFFLINE_QUEUE_STATUS", ...detail }),
  );
}

// A mutation the server keeps 500ing on must not wedge everything queued
// behind it forever: after this many 5xx replay attempts it is promoted to
// "failed", which surfaces it in the review dialog for retry or discard.
const MAX_REPLAY_ATTEMPTS = 5;

function receiptExpired(item) {
  const queuedAt = Date.parse(item.queuedAt);
  return Number.isFinite(queuedAt) && Date.now() - queuedAt > RECEIPT_TTL_MS;
}

async function replayQueue() {
  const items = await queueItems();
  for (const item of items) {
    if (item.state !== "pending") continue;
    if (receiptExpired(item)) {
      item.state = "failed";
      item.error =
        "This offline change is older than 30 days and can no longer be replayed. Server receipts expire after 30 days, so replaying now could duplicate the write.";
      await saveQueueItem(item);
      continue;
    }
    const headers = new Headers(item.headers);
    headers.set("X-Offline-Mutation-ID", item.id);
    headers.set("X-Offline-Queued-At", item.queuedAt);
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers,
        body: item.body,
        credentials: "include",
      });
      if (response.ok) {
        await deleteQueueItem(item.id);
        continue;
      }
      const errorBody = await response.clone().json().catch(() => null);
      if (
        response.status === 412 ||
        response.headers.has("X-Offline-Conflict")
      ) {
        item.state = "conflict";
        item.error =
          errorBody?.error ||
          "A newer server edit conflicts with this offline change.";
        await saveQueueItem(item);
        continue;
      }
      if (
        response.status === 409 &&
        errorBody?.error?.includes("already processing")
      ) {
        // Another replay holds the receipt. Leave pending and keep going so
        // one in-flight item cannot wedge the rest of the queue.
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        // Stay pending and keep the saved queue. Broadcast needsAuth so the
        // UI can prompt sign-in; do not drop state or skip the persist.
        item.needsAuth = true;
        item.error =
          errorBody?.error ||
          (response.status === 401
            ? "Sign in to sync queued changes."
            : "You do not have permission to sync this queued change.");
        await saveQueueItem(item);
        break;
      }
      if (response.status >= 400 && response.status < 500) {
        item.state = "failed";
        item.error =
          errorBody?.error ||
          "The server rejected this offline change.";
        await saveQueueItem(item);
        continue;
      }
      // 5xx: count the attempt. Network errors (offline) are not counted —
      // being offline is the queue's normal condition, not the item's fault.
      item.retryCount = (item.retryCount || 0) + 1;
      if (item.retryCount >= MAX_REPLAY_ATTEMPTS) {
        item.state = "failed";
        item.error =
          errorBody?.error ||
          "The server kept failing while replaying this change.";
        await saveQueueItem(item);
        continue;
      }
      await saveQueueItem(item);
      break;
    } catch {
      break;
    }
  }
  await broadcastQueueStatus();
}

function queueableBody(request) {
  if (request.method === "DELETE") return true;
  const contentType = (request.headers.get("content-type") || "").trim();
  // Body-less field actions (mark feeder empty, mark deadout, end bloom)
  // omit Content-Type. JSON bodies still queue; multipart does not.
  if (!contentType) return true;
  return contentType.includes("application/json");
}

function queueableMutation(request, url) {
  if (
    !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
    !url.pathname.startsWith("/api/v1/") ||
    !queueableBody(request)
  ) {
    return false;
  }
  // OFFLINE_ROUTES is generated from the Go middleware's manifest, so the
  // queue and the server's replay receipts always cover the same routes.
  return offlineRouteSupported(request.method, url.pathname);
}

function offlineRouteMatches(rule, method, path) {
  if (rule.exact ? path !== rule.prefix : !path.startsWith(rule.prefix)) {
    return false;
  }
  if (rule.methods && rule.methods.length > 0) {
    return rule.methods.includes(method);
  }
  return !(rule.exceptMethods || []).includes(method);
}

function offlineRouteSupported(method, path) {
  if (!OFFLINE_ROUTES.rules.some((rule) => offlineRouteMatches(rule, method, path))) {
    return false;
  }
  if (method !== "POST") return true;
  return !OFFLINE_ROUTES.postExclusions.includes(path);
}

function cacheableAPI(url) {
  return (
    url.pathname.startsWith("/api/v1/") &&
    !url.pathname.startsWith("/api/v1/auth/") &&
    !url.pathname.startsWith("/api/v1/access/") &&
    !url.pathname.startsWith("/api/v1/settings/")
  );
}

async function putDataCache(cache, request, response) {
  try {
    await cache.delete(request);
    await cache.put(request, response);
    const keys = await cache.keys();
    const extra = keys.length - DATA_CACHE_LIMIT;
    for (let i = 0; i < extra; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    // QuotaExceeded or other cache write failure must not reject the fetch.
  }
}

async function networkFirstAPI(request) {
  const cache = await caches.open(DATA_CACHE);
  // The network response refreshes the cache whenever it arrives — even
  // after the timeout below already served the cached copy, the late fresh
  // response is stored for next time instead of being discarded (rural
  // links routinely exceed the soft timeout).
  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      await putDataCache(cache, request, response.clone());
    }
    return response;
  });
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("network timeout")), 5000),
      ),
    ]);
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const copy = cached.clone();
      const headers = new Headers(cached.headers);
      headers.set("X-Beez-Cache", "stale");
      const stale = new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
      void putDataCache(cache, request, copy);
      return stale;
    }
    // Nothing cached: better to keep waiting on the slow network than fail.
    return network;
  }
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  // Per-URL so one missing app route cannot fail the whole install.
  await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
}

async function navigateFallback(request, url) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const byPath = await caches.match(url.pathname);
  if (byPath) return byPath;
  return (await caches.match("/offline")) || Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("beez-trackz-") &&
                key !== SHELL_CACHE &&
                key !== DATA_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => replayQueue()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/auth/logout"
  ) {
    event.respondWith(
      fetch(request).then(async (response) => {
        if (response.ok) {
          await clearPrivateOfflineState();
        }
        return response;
      }),
    );
    return;
  }

  if (
    (request.method === "POST" &&
      url.pathname === "/api/v1/auth/login") ||
    (request.method === "GET" &&
      url.pathname === "/api/v1/auth/oidc/callback")
  ) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok || response.redirected) {
          // Clear cached API data from the previous session, but keep the
          // mutation queue: the common case is the same beekeeper signing
          // back in after a session expiry with a day of queued field work
          // that must replay, not be destroyed. Logout keeps the queue too.
          event.waitUntil(
            caches
              .delete(DATA_CACHE)
              .then(() => replayQueue()),
          );
        }
        return response;
      }),
    );
    return;
  }

  if (request.method === "GET" && cacheableAPI(url)) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  if (queueableMutation(request, url)) {
    const mutationHeaders = new Headers(request.headers);
    if (!mutationHeaders.has("X-Offline-Mutation-ID")) {
      mutationHeaders.set("X-Offline-Mutation-ID", crypto.randomUUID());
    }
    const mutationRequest = new Request(request.clone(), {
      headers: mutationHeaders,
    });
    event.respondWith(
      fetch(mutationRequest.clone()).catch(async () => {
        try {
          const item = await queueRequest(mutationRequest);
          if ("sync" in self.registration) {
            void self.registration.sync.register("beez-trackz-replay");
          }
          return new Response(
            JSON.stringify({
              queued: true,
              offline: true,
              mutationId: item.id,
            }),
            {
              status: 202,
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (error) {
          const full =
            error &&
            typeof error.message === "string" &&
            error.message === QUEUE_FULL_ERROR;
          return new Response(
            JSON.stringify({
              error: full
                ? "Offline queue is full. Reconnect to sync, or discard failed changes."
                : "Could not queue this offline change.",
            }),
            {
              status: full ? 507 : 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }),
    );
    return;
  }

  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => navigateFallback(request, url)),
    );
    return;
  }
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/apple-touch-icon.png"
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok) {
            void caches
              .open(SHELL_CACHE)
              .then((cache) => cache.put(request, response.clone()));
          }
          return response;
        });
        return cached || network;
      }),
    );
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "beez-trackz-replay") event.waitUntil(replayQueue());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "REPLAY_OFFLINE_QUEUE") {
    event.waitUntil(replayQueue());
  }
  if (event.data?.type === "GET_OFFLINE_QUEUE_STATUS") {
    event.waitUntil(broadcastQueueStatus());
  }
  if (event.data?.type === "RETRY_OFFLINE_MUTATION") {
    event.waitUntil(
      queueItems().then(async (items) => {
        const item = items.find((value) => value.id === event.data.id);
        if (item) {
          item.state = "pending";
          item.error = null;
          item.retryCount = 0;
          item.needsAuth = false;
          item.retriedAt = new Date().toISOString();
          await saveQueueItem(item);
          await replayQueue();
        }
      }),
    );
  }
  if (event.data?.type === "DISCARD_OFFLINE_MUTATION") {
    event.waitUntil(
      deleteQueueItem(event.data.id).then(() => broadcastQueueStatus()),
    );
  }
});
`;

export function GET() {
  return new Response(serviceWorker, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
