import { spawnSync } from "node:child_process";
import process from "node:process";

import { verifyRequiredOrchestratorSecrets } from "./cloudflare-worker-secret-verifier.mjs";

try {
  if (process.argv.length !== 2) {
    throw new Error("Production Worker secret verification takes no arguments");
  }
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "secret",
      "list",
      "--format",
      "json",
      "--config",
      ".wrangler/deploy/orchestrator-production.toml",
      "--env",
      "production",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "0",
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Wrangler could not list encrypted production Worker secret names");
  }
  const verification = verifyRequiredOrchestratorSecrets(
    result.stdout,
    "production",
    process.env.SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_MODE ?? "disabled",
  );
  console.log(
    `Verified required encrypted production Worker secrets: ${verification.requiredCount}`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to verify production Worker secrets",
  );
  process.exitCode = 1;
}
