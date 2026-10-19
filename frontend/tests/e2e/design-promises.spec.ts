import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Each documented promise in DESIGN.md / README.md is paired here with the
 * code that has to keep it. These assertions read source rather than drive the
 * app so the pair fails together the moment one half drifts.
 */

const repoRoot = join(__dirname, "..", "..", "..");
const srcRoot = join(__dirname, "..", "..", "src");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

/** The service worker body, read from the route that serves it. */
function serviceWorkerSource(): string {
  return read(srcRoot, "app", "sw.js", "route.ts");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

test("safe-area handling lives only in globals.css (DESIGN.md)", () => {
  const design = read(repoRoot, "DESIGN.md");
  expect(design).toContain("--safe-top");
  expect(design).toContain(".pb-safe");
  expect(design).toContain("nothing else calls `env(safe-area-inset-*)`");

  const globals = join(srcRoot, "app", "globals.css");
  const css = readFileSync(globals, "utf8");
  for (const side of ["top", "right", "bottom", "left"]) {
    expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
    expect(css).toContain(`.p${side[0]}-safe`);
  }
  // The mobile bar height is derived from the token, not a second env() call.
  expect(css).toContain("--bottom-nav-h: calc(3.25rem + var(--safe-bottom));");

  const offenders = sourceFiles(srcRoot).filter(
    (file) =>
      file !== globals &&
      readFileSync(file, "utf8").includes("env(safe-area-inset"),
  );
  expect(offenders, "use var(--safe-*) or .p?-safe instead of env()").toEqual(
    [],
  );
});

test("mobile route navigation uses named page links instead of a route select (DESIGN.md)", () => {
  const design = read(repoRoot, "DESIGN.md");
  expect(design).toContain("Today, Apiaries, Stock, Sales, and Insights are the five areas");
  expect(design).toContain("Setup is not an area");

  // One page header owns the phone disclosure; there is no in-page strip
  // component left to duplicate the sidebar.
  const pageHeader = read(srcRoot, "components", "shell", "page-header.tsx");
  expect(pageHeader).toContain("<details");
  expect(pageHeader).not.toContain("<Select");
  expect(existsSync(join(srcRoot, "components", "shell", "section-nav.tsx"))).toBe(false);

  // The bar's fifth slot is "More", never the disclosure's name.
  const bottomNav = read(srcRoot, "components", "shell", "bottom-nav.tsx");
  expect(bottomNav).toContain("<SheetTitle>More</SheetTitle>");
  expect(bottomNav).not.toContain("Pages");

  for (const page of [join(srcRoot, "features", "apiaries", "detail-page.tsx"), join(srcRoot, "features", "hives", "detail-page.tsx")]) {
    const source = readFileSync(page, "utf8");
    expect(source).not.toContain("<TabsList");
    expect(source).toContain("<nav aria-label=");
  }
});

test("every area page title and h1 come from the route index, not a hand-written string", () => {
  const appRoot = join(srcRoot, "app", "(app)");
  const offenders = sourceFiles(appRoot).filter((file) => {
    if (!file.endsWith("page.tsx")) return false;
    // Record routes own their titles until the record-page wave.
    if (file.includes("[id]") || file.includes("[runId]")) return false;
    const source = readFileSync(file, "utf8");
    return /export const metadata(: Metadata)? = \{/.test(source);
  });
  expect(offenders, "use pageMetadata(href) instead of a literal title").toEqual([]);
});

test("offline navigation serves cached pages before /offline (README.md)", () => {
  const readme = read(repoRoot, "README.md");
  expect(readme).toContain(
    "`/offline` is only shown for a route that was never",
  );
  expect(readme).toContain("Auth, access, and settings reads are never cached");

  const sw = serviceWorkerSource();

  const fallback = sw.slice(
    sw.indexOf("async function navigateFallback"),
    sw.indexOf('self.addEventListener("install"'),
  );
  expect(fallback).toContain("caches.match(request)");
  expect(fallback).toContain("caches.match(url.pathname)");
  // /offline is the last resort, after both cache lookups.
  expect(fallback.indexOf("caches.match(request)")).toBeLessThan(
    fallback.indexOf('caches.match("/offline")'),
  );
  expect(sw).toContain(
    "fetch(request).catch(() => navigateFallback(request, url))",
  );

  // The routes the README names as available offline are precached.
  const shellStart = sw.indexOf("const SHELL = [");
  const shell = sw.slice(shellStart, sw.indexOf("];", shellStart));
  for (const route of [
    "/offline",
    "/login",
    "/today",
    "/yard/queue",
    "/yard/hives",
    "/production",
    "/sales",
    "/sales/market-day",
  ]) {
    expect(shell).toContain(`"${route}"`);
  }

  const cacheable = sw.slice(
    sw.indexOf("function cacheableAPI"),
    sw.indexOf("async function putDataCache"),
  );
  for (const excluded of [
    "/api/v1/auth/",
    "/api/v1/access/",
    "/api/v1/settings/",
    // Per-user preferences and operation policy, after the settings split.
    "/api/v1/me/",
    "/api/v1/admin/",
  ]) {
    expect(cacheable).toContain(`!url.pathname.startsWith("${excluded}")`);
  }
});

test("conflicts stay reviewable and retry cannot overwrite (README.md)", () => {
  const readme = read(repoRoot, "README.md");
  expect(readme).toContain("reviewable conflict instead of");
  expect(readme).toContain("cannot force the overwrite");

  const sw = serviceWorkerSource();

  // A conflicting replay is parked for review, never retried silently.
  const replay = sw.slice(
    sw.indexOf("async function replayQueue"),
    sw.indexOf("function queueableBody"),
  );
  expect(replay).toContain('response.headers.has("X-Offline-Conflict")');
  expect(replay).toContain('item.state = "conflict"');
  expect(replay).toContain('headers.set("X-Offline-Queued-At", item.queuedAt)');

  // Retry re-sends the original queue time, so the server can refuse again.
  const retry = sw.slice(
    sw.indexOf('event.data?.type === "RETRY_OFFLINE_MUTATION"'),
    sw.indexOf('event.data?.type === "DISCARD_OFFLINE_MUTATION"'),
  );
  expect(retry).toContain("retriedAt");
  expect(retry).not.toContain("queuedAt =");
  expect(retry).not.toContain("delete item.queuedAt");

  // The review UI names both choices and says retry does not overwrite.
  const ui = read(srcRoot, "components", "pwa-register.tsx");
  expect(ui).toContain("data-queue-state={item.state}");
  expect(ui).toContain("Retry without overwriting");
  expect(ui).toContain("Discard my change");
  expect(ui).toContain("Retrying");
  expect(ui).toContain("DISCARD_OFFLINE_MUTATION");
  expect(ui).toContain("RETRY_OFFLINE_MUTATION");
});
