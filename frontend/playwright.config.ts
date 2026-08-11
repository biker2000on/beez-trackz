import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "line",
  // Next's development server compiles dynamic routes on first use. Keep UI
  // assertions tolerant of that cold compile while still failing quickly.
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
