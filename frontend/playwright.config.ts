import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // Every route is compiled once by the global setup before any test runs, so
  // no assertion races the dev server's first compile of the page it is
  // looking at. See tests/e2e/global-setup.ts for why this is warming rather
  // than a production build.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  // The suite shares one `next dev` compiler. HTTP warming pays the server
  // compile cost, but the first real browser navigation still asks Turbopack
  // for client chunks; concurrent cold navigations can leave every page on
  // Next's empty development error shell until its test times out. One worker
  // makes that startup deterministic on the supported Windows checkout.
  workers: 1,
  reporter: "line",
  // One `next dev` server serves every worker, so a test's wall time depends
  // on what is running beside it. The per-assertion budget stays at 15 s —
  // that is the one that catches a page which never renders — while the
  // whole-test cap is generous enough that contention alone cannot fail a
  // test that is passing.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3010",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- -p 3010",
    url: "http://localhost:3010/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
