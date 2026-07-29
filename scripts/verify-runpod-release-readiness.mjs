import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { runRunpodCliWithReadRetry } from "./runpod-cli-retry.mjs";
import { validateRunpodGpuInventoryConfiguration } from "./runpod-environment-config.mjs";
import { verifyRunpodReleaseReadiness } from "./runpod-template-api.mjs";

const environment = process.argv[2];

function retryLogger({ attempt, command, maximumAttempts }) {
  console.warn(
    `Retrying read-only RunPod REST ${command} (${String(attempt)}/${String(maximumAttempts)})`,
  );
}

function cliRetryLogger({ attempt, command, maximumAttempts }) {
  console.warn(
    `Retrying read-only RunPod ${command} (${String(attempt)}/${String(maximumAttempts)})`,
  );
}

function runCliOnce(arguments_) {
  const result = spawnSync(path.resolve(".tools", "bin", "runpodctl"), arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`runpodctl ${arguments_.slice(0, 2).join(" ")} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`runpodctl ${arguments_.slice(0, 2).join(" ")} returned invalid JSON`);
  }
}

try {
  if (environment !== "staging" || process.argv.length !== 3) {
    throw new Error("Usage: verify-runpod-release-readiness staging");
  }
  if (process.env["GITHUB_ACTIONS"] !== "true") {
    throw new Error("RunPod release readiness is restricted to GitHub Actions");
  }
  if (!String(process.env["GITHUB_WORKFLOW_REF"] ?? "").includes("/publish-runpod-worker.yml@")) {
    throw new Error("RunPod release readiness workflow identity is invalid");
  }

  const apiKey = process.env["RUNPOD_API_KEY"];
  const endpointId = process.env["SCRIBE_DROP_STAGING_RUNPOD_ENDPOINT_ID"];
  const gpuInventory = runRunpodCliWithReadRetry(
    ["gpu", "list", "--include-unavailable"],
    runCliOnce,
    {
      onRetry: cliRetryLogger,
    },
  );
  validateRunpodGpuInventoryConfiguration(
    gpuInventory,
    process.env["SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS"],
    "staging",
  );
  await verifyRunpodReleaseReadiness(
    { apiKey, endpointId },
    {
      onRetry: retryLogger,
    },
  );
  console.log("Verified read-only staging RunPod release readiness.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "RunPod release readiness verification failed",
  );
  process.exitCode = 1;
}
