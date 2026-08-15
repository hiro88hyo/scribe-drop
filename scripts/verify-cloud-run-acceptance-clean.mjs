import { spawn } from "node:child_process";
import process from "node:process";

const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;
const databases = Object.freeze({
  production: "scribe-production-controller",
  staging: "scribe-staging-controller",
});

function requireIntegerField(document, name) {
  const value = document?.fields?.[name]?.integerValue;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Controller authorization document is invalid");
  }
  return Number(value);
}

function requireStringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  if (typeof value !== "string") throw new Error("Controller document is invalid");
  return value;
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

const [selectedEnvironment] = process.argv.slice(2);
if (!new Set(["staging", "production"]).has(selectedEnvironment) || process.argv.length !== 3) {
  throw new Error("Usage: verify-cloud-run-acceptance-clean <staging|production>");
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
  const [jobs, executions, environmentDocument, executionDocuments] = await Promise.all([
    runGcloud(["run", "jobs", "list", ...common]),
    runGcloud(["run", "jobs", "executions", "list", ...common]),
    firestore(`scribe_drop_controller_environments/${selectedEnvironment}`),
    firestore("scribe_drop_controller_executions?pageSize=2"),
  ]);
  if (jobs.length !== 0 || executions.length !== 0) {
    throw new Error("Cloud Run acceptance resources have not converged to zero");
  }
  if (
    requireIntegerField(environmentDocument, "activeExecutions") !== 0 ||
    requireIntegerField(environmentDocument, "maxExecutions") !== 1 ||
    requireIntegerField(environmentDocument, "maxWorstCaseJpy") !== 250 ||
    requireIntegerField(environmentDocument, "reservedExecutions") !== 1 ||
    requireIntegerField(environmentDocument, "reservedWorstCaseJpy") !== 250 ||
    requireIntegerField(environmentDocument, "worstCaseJpyPerExecution") !== 250 ||
    !requireStringField(environmentDocument, "epoch").startsWith("phase16-")
  ) {
    throw new Error("Cloud Run acceptance authorization did not consume exact one execution");
  }
  if (
    !Array.isArray(executionDocuments.documents) ||
    executionDocuments.documents.length !== 1 ||
    executionDocuments.nextPageToken !== undefined
  ) {
    throw new Error("Cloud Run acceptance execution identity is not exact one");
  }
  const record = executionDocuments.documents[0]?.fields?.record?.mapValue?.fields;
  if (
    record?.state?.stringValue !== "CLEANED" ||
    record?.cleanupIntent?.booleanValue !== true ||
    record?.execution?.nullValue !== null ||
    record?.job?.nullValue !== null
  ) {
    throw new Error("Cloud Run acceptance execution did not converge to CLEANED");
  }
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
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud Run acceptance cleanup failed");
  process.exitCode = 1;
}
