import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import { verifyAuthorizedAcceptanceSnapshot } from "./cloud-run-acceptance-state.mjs";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;
const databases = Object.freeze({
  production: "scribe-production-controller",
  staging: "scribe-staging-controller",
});

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
  if (exitCode !== 0) throw new Error("Cloud Run resource read-back failed");
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new Error("Cloud Run resource read-back was invalid");
  }
}

async function firestore(path) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${databaseId}/documents/${path}`,
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
    throw new Error(`Firestore acceptance read-back failed: ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Firestore acceptance read-back was invalid");
  }
}

const [selectedEnvironment, sourceRunPath] = process.argv.slice(2);
if (
  !new Set(["staging", "production"]).has(selectedEnvironment) ||
  sourceRunPath === undefined ||
  process.argv.length !== 4
) {
  throw new Error(
    "Usage: verify-cloud-run-acceptance-clean <staging|production> <source-run-json>",
  );
}
const databaseId = databases[selectedEnvironment];
const accessToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
if (typeof accessToken !== "string" || !tokenPattern.test(accessToken)) {
  throw new Error("Google OAuth access token is missing or invalid");
}

try {
  const filter = `metadata.labels.scribe-drop-environment=${selectedEnvironment}`;
  const common = [
    `--project=${PROJECT_ID}`,
    `--region=${REGION}`,
    `--filter=${filter}`,
    "--limit=100",
    "--format=json",
  ];
  const expectedEpoch = process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [jobs, executions, environmentDocument, executionDocuments] = await Promise.all([
      runGcloud(["run", "jobs", "list", ...common]),
      runGcloud(["run", "jobs", "executions", "list", ...common]),
      firestore(`scribe_drop_controller_environments/${selectedEnvironment}`),
      firestore("scribe_drop_controller_executions?pageSize=100"),
    ]);
    const result = verifyAuthorizedAcceptanceSnapshot(
      { environmentDocument, executionDocuments, executions, jobs },
      expectedEpoch,
      selectedEnvironment,
      JSON.parse(readFileSync(sourceRunPath, "utf8")),
    );
    if (result.complete) {
      console.log(
        JSON.stringify({
          activeExecutions: 0,
          environment: selectedEnvironment,
          executionCount: 0,
          jobCount: 0,
          providerRecord: "CLEANED",
          reservedExecutions: 1,
        }),
      );
      process.exit(0);
    }
    if (attempt < 59) await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error("Cloud Run acceptance cleanup did not converge within 20 minutes");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud Run acceptance cleanup failed");
  process.exitCode = 1;
}
