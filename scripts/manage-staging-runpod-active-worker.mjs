import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  cooldownStagingRunpodCandidate,
  prewarmStagingRunpodCandidate,
} from "./runpod-active-worker.mjs";
import { validateCreatedRunpodTemplate, validateRunpodPlan } from "./runpod-environment-config.mjs";
import {
  getRunpodEndpointCapacity,
  getRunpodEndpointHealth,
  listRunpodTemplates,
  setRunpodEndpointWorkersMin,
} from "./runpod-template-api.mjs";
import { runRunpodCliWithReadRetry } from "./runpod-cli-retry.mjs";

const [operation] = process.argv.slice(2);
const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;

function requireResourceId(value, name) {
  if (typeof value !== "string" || !resourceIdPattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function runCliOnce(arguments_) {
  const result = spawnSync(path.resolve(".tools", "bin", "runpodctl"), arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error("RunPod template read failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("RunPod template read returned invalid JSON");
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
  if ((operation !== "prewarm" && operation !== "cooldown") || process.argv.length !== 3) {
    throw new Error("Usage: manage-staging-runpod-active-worker <prewarm|cooldown>");
  }
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    !String(process.env["GITHUB_WORKFLOW_REF"] ?? "").includes("/deploy-staging-candidate.yml@")
  ) {
    throw new Error("RunPod staging active worker control is restricted to GitHub Actions");
  }
  const apiKey = process.env["RUNPOD_API_KEY"];
  const endpointId = requireResourceId(
    process.env["SCRIBE_DROP_STAGING_RUNPOD_ENDPOINT_ID"],
    "RunPod staging endpoint ID",
  );
  const plan = validateRunpodPlan(
    JSON.parse(readFileSync(path.resolve(".runpod", "deploy", "staging-plan.json"), "utf8")),
    "staging",
  );
  const dependencies = {
    getCapacity({ endpointId: targetEndpointId }) {
      return getRunpodEndpointCapacity({
        apiKey,
        endpointId: targetEndpointId,
      });
    },
    getEndpoint({ endpointId: targetEndpointId }) {
      return Promise.resolve(
        runCli(["serverless", "get", targetEndpointId, "--include-template", "--include-workers"]),
      );
    },
    getHealth({ endpointId: targetEndpointId }) {
      return getRunpodEndpointHealth({
        apiKey,
        endpointId: targetEndpointId,
      });
    },
    setWorkersMin({ endpointId: targetEndpointId, workersMin }) {
      return setRunpodEndpointWorkersMin({
        apiKey,
        endpointId: targetEndpointId,
        workersMin,
      });
    },
  };
  if (operation === "prewarm") {
    const templates = await listRunpodTemplates({ apiKey });
    const matches = templates.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry.name === plan.template.name,
    );
    if (matches.length !== 1) {
      throw new Error("RunPod candidate template identity is ambiguous");
    }
    const templateId = requireResourceId(matches[0].id, "RunPod candidate template ID");
    validateCreatedRunpodTemplate(runCli(["template", "get", templateId]), plan);
    const input = { endpointId, plan, templateId };
    await prewarmStagingRunpodCandidate(input, dependencies);
    console.log("Verified the staging candidate worker is ready before job creation.");
  } else {
    const input = { endpointId, plan };
    await cooldownStagingRunpodCandidate(input, dependencies);
    console.log("Restored staging RunPod scale-to-zero.");
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "RunPod staging active worker control failed",
  );
  process.exitCode = 1;
}
