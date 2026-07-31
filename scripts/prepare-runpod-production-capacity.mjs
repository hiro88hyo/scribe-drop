import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateRunpodPlan } from "./runpod-environment-config.mjs";
import { runRunpodCliWithReadRetry } from "./runpod-cli-retry.mjs";
import { prepareRunpodProductionCapacity } from "./runpod-promotion.mjs";
import {
  getRunpodEndpointCapacity,
  getRunpodEndpointHealth,
  setRunpodEndpointDataCenters,
  setRunpodEndpointGpuTypes,
  setRunpodEndpointWorkersMax,
  verifyRunpodServerlessGpuTypes,
} from "./runpod-template-api.mjs";

const confirmation = "--confirm-production-capacity-migration";
const planPath = path.resolve(".runpod", "deploy", "production-plan.json");
const runpodctl = path.resolve(".tools", "bin", "runpodctl");

function runCliOnce(arguments_) {
  const result = spawnSync(runpodctl, arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
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

function runCli(arguments_) {
  return runRunpodCliWithReadRetry(arguments_, runCliOnce, {
    onRetry({ attempt, command, maximumAttempts }) {
      console.warn(
        `Retrying read-only RunPod ${command} (${String(attempt)}/${String(maximumAttempts)})`,
      );
    },
  });
}

try {
  if (process.argv.length !== 3 || process.argv[2] !== confirmation) {
    throw new Error(
      "Usage: prepare-runpod-production-capacity --confirm-production-capacity-migration",
    );
  }
  if (process.env["GITHUB_ACTIONS"] === "true") {
    throw new Error("RunPod production capacity preparation cannot run in GitHub Actions");
  }
  if (!existsSync(runpodctl)) {
    throw new Error("runpodctl is not installed; run pnpm run runpodctl:install");
  }
  if (!existsSync(planPath)) {
    throw new Error("RunPod production plan is missing");
  }
  const plan = validateRunpodPlan(JSON.parse(readFileSync(planPath, "utf8")), "production");
  await verifyRunpodServerlessGpuTypes({ gpuTypeIds: plan.endpoint.gpuTypeIds });
  const apiKey = process.env["RUNPOD_API_KEY"];
  const endpointId = process.env["SCRIBE_DROP_PRODUCTION_RUNPOD_ENDPOINT_ID"];
  const result = await prepareRunpodProductionCapacity({
    endpointId,
    environment: "production",
    getEndpoint({ endpointId: targetEndpointId }) {
      return getRunpodEndpointCapacity({
        apiKey,
        endpointId: targetEndpointId,
      });
    },
    getHealth({ endpointId: targetEndpointId }) {
      return getRunpodEndpointHealth({
        apiKey,
        endpointId: targetEndpointId,
      });
    },
    listGpus() {
      return Promise.resolve(runCli(["gpu", "list", "--include-unavailable"]));
    },
    onCapacityReadBackRetry({ attempt, maximumAttempts }) {
      console.warn(
        `Waiting for RunPod production capacity read-back (${String(attempt)}/${String(
          maximumAttempts,
        )})`,
      );
    },
    onDrainHealthReadBackRetry({ attempt, maximumAttempts }) {
      console.warn(
        `Waiting for RunPod production drain health (${String(attempt)}/${String(
          maximumAttempts,
        )})`,
      );
    },
    plan,
    runCli,
    setEndpointDataCenters({ dataCenterIds, endpointId: targetEndpointId }) {
      return setRunpodEndpointDataCenters({
        apiKey,
        dataCenterIds,
        endpointId: targetEndpointId,
      });
    },
    setEndpointGpuTypes({ endpointId: targetEndpointId, gpuTypeIds }) {
      return setRunpodEndpointGpuTypes({
        apiKey,
        endpointId: targetEndpointId,
        gpuTypeIds,
      });
    },
    setEndpointWorkersMax({ endpointId: targetEndpointId, workersMax }) {
      return setRunpodEndpointWorkersMax({
        apiKey,
        endpointId: targetEndpointId,
        workersMax,
      });
    },
  });
  console.log(
    `Verified RunPod production capacity preparation (${result.changed ? "updated" : "unchanged"}).`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "RunPod production capacity preparation failed",
  );
  process.exitCode = 1;
}
