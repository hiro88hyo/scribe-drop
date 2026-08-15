import { spawnSync } from "node:child_process";
import process from "node:process";

const secretPattern = /^[A-Za-z0-9_-]{43,86}$/u;
const primary = process.env.SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_PRIMARY;
const derivation = process.env.SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_DERIVATION_SECRET;
if (
  typeof primary !== "string" ||
  typeof derivation !== "string" ||
  !secretPattern.test(primary) ||
  !secretPattern.test(derivation) ||
  primary === derivation ||
  process.argv.length !== 2
) {
  throw new Error("Production Cloud Run Worker secrets are missing or invalid");
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "secret",
    "bulk",
    "--config",
    ".wrangler/deploy/orchestrator-production.toml",
    "--env",
    "production",
  ],
  {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_WRITE_LOGS: "0" },
    input: JSON.stringify({
      CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: primary,
      CLOUD_RUN_RUNTIME_DERIVATION_SECRET: derivation,
    }),
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  },
);
if (result.error !== undefined || result.status !== 0) {
  throw new Error("Production Cloud Run Worker secret update failed");
}
console.log("Updated exactly two production Cloud Run Worker secrets.");
