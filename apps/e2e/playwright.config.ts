import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: false,
  outputDir: "../../test-results/e2e",
  reporter: process.env["CI"] ? "line" : "list",
  retries: 0,
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @scribe-drop/web run preview:e2e",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
    url: baseURL,
  },
  workers: 1,
});
