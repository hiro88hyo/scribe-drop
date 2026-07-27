import { defineConfig } from "@playwright/test";

function requireExactHttpsOrigin(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("SCRIBE_DROP_STAGING_WEB_ORIGIN is required");
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    throw new Error("SCRIBE_DROP_STAGING_WEB_ORIGIN must be an exact HTTPS origin");
  }
  return value;
}

const baseURL = requireExactHttpsOrigin(process.env["SCRIBE_DROP_STAGING_WEB_ORIGIN"]);

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "../../test-results/staging-e2e",
  reporter: "line",
  retries: 0,
  testDir: "./staging-tests",
  timeout: 25 * 60 * 1_000,
  use: {
    baseURL,
    screenshot: "off",
    serviceWorkers: "block",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
