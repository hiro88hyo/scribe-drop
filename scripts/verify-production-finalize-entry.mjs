import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { verifyProductionFinalizeSnapshot } from "./cloud-run-acceptance-state.mjs";
import { requireProductionFinalizeStage } from "./production-finalize-state.mjs";
import {
  createProductionSmokeD1Arguments,
  parseProductionSmokeObservation,
} from "./production-smoke.mjs";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const DATABASE_ID = "scribe-production-controller";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;

function positiveInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}

async function runGcloud(arguments_) {
  const child = spawn("gcloud", arguments_, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderrBytes = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 512 * 1024) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) child.kill("SIGTERM");
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error("Production finalize Cloud Run read-back failed");
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new Error("Production finalize Cloud Run inventory is invalid");
  }
}

async function runPnpm(arguments_) {
  const child = spawn("pnpm", arguments_, {
    env: { ...process.env, WRANGLER_WRITE_LOGS: "0" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderrBytes = 0;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 2 * 1024 * 1024) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) child.kill("SIGTERM");
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(`Production finalize D1 read-back failed with exit code ${String(exitCode)}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Production finalize D1 read-back is invalid");
  }
}

async function firestore(path, accessToken) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${path}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-goog-user-project": PROJECT_ID,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const text = await response.text();
  if (response.status !== 200 || text.length > 512 * 1024) {
    throw new Error(`Production finalize Firestore read-back failed: ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Production finalize Firestore read-back is invalid");
  }
}

const [stageValue, sourceRunPath] = process.argv.slice(2);
if (stageValue === undefined || sourceRunPath === undefined || process.argv.length !== 4) {
  throw new Error("Usage: verify-production-finalize-entry <stage> <cutover-run-json>");
}
const stage = requireProductionFinalizeStage(stageValue);
const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
if (typeof accessToken !== "string" || !tokenPattern.test(accessToken)) {
  throw new Error("Google OAuth access token is missing or invalid");
}

try {
  const filter = "metadata.labels.scribe-drop-environment=production";
  const smokeJobId = process.env.PRODUCTION_SMOKE_JOB_ID;
  const configPath = path.resolve(".wrangler/deploy/orchestrator-production.toml");
  const common = [
    `--project=${PROJECT_ID}`,
    `--region=${REGION}`,
    `--filter=${filter}`,
    "--limit=100",
    "--format=json",
  ];
  const [jobs, executions, environmentDocument, executionDocuments, smokeD1] = await Promise.all([
    runGcloud(["run", "jobs", "list", ...common]),
    runGcloud(["run", "jobs", "executions", "list", ...common]),
    firestore("scribe_drop_controller_environments/production", accessToken),
    firestore("scribe_drop_controller_executions?pageSize=100", accessToken),
    runPnpm(createProductionSmokeD1Arguments(smokeJobId, configPath)),
  ]);
  const smoke = parseProductionSmokeObservation(smokeD1, smokeJobId);
  const operational = stage.startsWith("operational-");
  const result = verifyProductionFinalizeSnapshot(
    { environmentDocument, executionDocuments, executions, jobs },
    {
      maxExecutions: operational
        ? positiveInteger(
            process.env.SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS,
            "Operational maximum executions",
          )
        : undefined,
      maxWorstCaseJpy: operational
        ? positiveInteger(
            process.env.SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY,
            "Operational maximum worst-case JPY",
          )
        : undefined,
      operationalEpoch: process.env.SCRIBE_DROP_CLOUD_RUN_OPERATIONAL_EPOCH,
      smokeEpoch: process.env.SCRIBE_DROP_CLOUD_RUN_SMOKE_EPOCH,
      smokeExecutionHandle: smoke.executionHandle,
      stage,
      validUntil: process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL,
    },
    JSON.parse(readFileSync(sourceRunPath, "utf8")),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production finalize entry is invalid");
  process.exitCode = 1;
}
