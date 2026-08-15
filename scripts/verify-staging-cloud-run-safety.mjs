import { spawn } from "node:child_process";
import process from "node:process";

import { isStagingRecoveryReady, verifyStagingCloudRunSafe } from "./staging-cloud-run-safety.mjs";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const DATABASE = "scribe-staging-controller";
const token = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
const [command] = process.argv.slice(2);
if (
  !new Set(["read", "wait"]).has(command) ||
  process.argv.length !== 3 ||
  typeof token !== "string" ||
  !/^[\x21-\x7e]{20,8192}$/u.test(token)
) {
  throw new Error("Usage: verify-staging-cloud-run-safety <read|wait>");
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
  if (exitCode !== 0) throw new Error("Staging Cloud Run safety inventory failed");
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new Error("Staging Cloud Run safety inventory was invalid");
  }
}

async function readEnvironmentDocument() {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE}/documents/scribe_drop_controller_environments/staging`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "x-goog-user-project": PROJECT_ID,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const text = await response.text();
  if (response.status === 404) return undefined;
  if (response.status !== 200 || text.length > 512 * 1024) {
    throw new Error(`Staging controller authorization read failed: ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Staging controller authorization read was invalid");
  }
}

async function snapshot() {
  const common = [
    `--project=${PROJECT_ID}`,
    `--region=${REGION}`,
    "--filter=metadata.labels.scribe-drop-environment=staging",
    "--limit=100",
    "--format=json",
  ];
  const [jobs, executions, environmentDocument] = await Promise.all([
    runGcloud(["run", "jobs", "list", ...common]),
    runGcloud(["run", "jobs", "executions", "list", ...common]),
    readEnvironmentDocument(),
  ]);
  return { environmentDocument, executions, jobs };
}

try {
  if (command === "read") {
    console.log(JSON.stringify(verifyStagingCloudRunSafe(await snapshot())));
  } else {
    const expectedEpoch = process.env.SCRIBE_DROP_CLOUD_RUN_RECOVERY_EPOCH;
    if (
      typeof expectedEpoch !== "string" ||
      !/^phase16-smoke-[a-f0-9]{7,40}-[1-9][0-9]*$/u.test(expectedEpoch)
    ) {
      throw new Error("Staging Cloud Run recovery epoch is missing or invalid");
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await snapshot();
      if (
        current.jobs.length === 0 &&
        current.executions.length === 0 &&
        isStagingRecoveryReady(current.environmentDocument, expectedEpoch)
      ) {
        console.log(JSON.stringify({ activeExecutions: 0, executionCount: 0, jobCount: 0 }));
        process.exit(0);
      }
      if (attempt < 59) await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    throw new Error("Staging Cloud Run recovery did not converge within 20 minutes");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging Cloud Run safety check failed");
  process.exitCode = 1;
}
