import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import { verifyRecoveredAcceptanceSnapshot } from "./cloud-run-acceptance-state.mjs";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const DATABASE = "scribe-staging-controller";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;

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
  if (exitCode !== 0) throw new Error("Recovered Cloud Run resource read-back failed");
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Recovered Cloud Run inventory is invalid");
  return parsed;
}

async function firestore(path, accessToken) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE}/documents/${path}`,
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
    throw new Error(`Recovered Firestore read-back failed: ${response.status}`);
  }
  return JSON.parse(text);
}

const [sourceRunPath] = process.argv.slice(2);
const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;

try {
  if (
    sourceRunPath === undefined ||
    process.argv.length !== 3 ||
    typeof accessToken !== "string" ||
    !tokenPattern.test(accessToken)
  ) {
    throw new Error("Usage: verify-recovered-cloud-run-acceptance <source-run-json>");
  }
  const common = [
    `--project=${PROJECT_ID}`,
    `--region=${REGION}`,
    "--filter=metadata.labels.scribe-drop-environment=staging",
    "--limit=100",
    "--format=json",
  ];
  const [jobs, executions, environmentDocument, executionDocuments] = await Promise.all([
    runGcloud(["run", "jobs", "list", ...common]),
    runGcloud(["run", "jobs", "executions", "list", ...common]),
    firestore("scribe_drop_controller_environments/staging", accessToken),
    firestore("scribe_drop_controller_executions?pageSize=2", accessToken),
  ]);
  console.log(
    JSON.stringify(
      verifyRecoveredAcceptanceSnapshot(
        { environmentDocument, executionDocuments, executions, jobs },
        JSON.parse(readFileSync(sourceRunPath, "utf8")),
      ),
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Recovered Cloud Run acceptance verification failed",
  );
  process.exitCode = 1;
}
