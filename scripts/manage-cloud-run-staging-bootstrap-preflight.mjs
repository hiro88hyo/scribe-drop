import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import {
  createStagingBootstrapPreflightPlan,
  verifyStagingBootstrapPreflightJob,
  verifyStagingBootstrapPreflightMarkers,
} from "./cloud-run-staging-bootstrap-preflight.mjs";
import { parseStagingReleaseInputs } from "./staging-release-inputs.mjs";

const localGcloud = path.resolve(".tools/bin/gcloud");
const gcloud = existsSync(localGcloud) ? localGcloud : "gcloud";
const gcloudEnvironment = {
  ...process.env,
  ...(existsSync(localGcloud) ? { CLOUDSDK_CONFIG: path.resolve(".tools/gcloud-config") } : {}),
};
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(value, length) {
  let current = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = crockford[Number(current & 31n)] + encoded;
    current >>= 5n;
  }
  if (current !== 0n) throw new Error("ULID component overflow");
  return encoded;
}

function createUlid() {
  const timestamp = encodeCrockford(BigInt(Date.now()), 10);
  const random = randomBytes(10);
  let randomValue = 0n;
  for (const byte of random) randomValue = (randomValue << 8n) | BigInt(byte);
  return `${timestamp}${encodeCrockford(randomValue, 16)}`;
}

function requireGithubActionsIdentity() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REPOSITORY !== "hiro88hyo/scribe-drop" ||
    !/^refs\/heads\/release\/[0-9]+\.[0-9]+\.[0-9]+$/u.test(process.env.GITHUB_REF ?? "") ||
    !/^hiro88hyo\/scribe-drop\/\.github\/workflows\/deploy-staging-candidate\.yml@refs\/heads\/release\/[0-9]+\.[0-9]+\.[0-9]+$/u.test(
      process.env.GITHUB_WORKFLOW_REF ?? "",
    )
  ) {
    throw new Error("GPU-free preflight requires the exact staging deployment workflow identity");
  }
}

async function runGcloud(arguments_, { optional = false, timeoutMs = 120_000 } = {}) {
  const child = spawn(gcloud, arguments_, {
    env: gcloudEnvironment,
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
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  if (exitCode !== 0 && !optional) throw new Error("GPU-free preflight gcloud operation failed");
  return { exitCode, stdout };
}

async function gcloudJson(arguments_, options) {
  const result = await runGcloud([...arguments_, "--format=json"], options);
  if (result.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GPU-free preflight gcloud read returned invalid JSON");
  }
}

function common(plan) {
  return [`--project=${plan.projectId}`, `--region=${plan.region}`, "--quiet"];
}

async function stagingResources(plan) {
  const filter = "metadata.labels.scribe-drop-environment=staging";
  const [jobs, executions] = await Promise.all([
    gcloudJson(["run", "jobs", "list", ...common(plan), `--filter=${filter}`, "--limit=100"]),
    gcloudJson([
      "run",
      "jobs",
      "executions",
      "list",
      ...common(plan),
      `--filter=${filter}`,
      "--limit=100",
    ]),
  ]);
  if (!Array.isArray(jobs) || !Array.isArray(executions)) {
    throw new Error("GPU-free preflight Cloud Run inventory is invalid");
  }
  return { executions, jobs };
}

async function requireStagingZero(plan) {
  const resources = await stagingResources(plan);
  if (resources.jobs.length !== 0 || resources.executions.length !== 0) {
    throw new Error("GPU-free preflight requires staging Cloud Run Job and Execution zero");
  }
}

async function waitForStagingZero(plan) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const resources = await stagingResources(plan);
    if (resources.jobs.length === 0 && resources.executions.length === 0) return;
    if (attempt < 89) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("GPU-free preflight cleanup did not converge to zero");
}

const [candidatePath] = process.argv.slice(2);
if (candidatePath === undefined || process.argv.length !== 3) {
  throw new Error("Usage: manage-cloud-run-staging-bootstrap-preflight <candidate-evidence>");
}

try {
  requireGithubActionsIdentity();
  const expectedCommit = process.env.EXPECTED_COMMIT_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    typeof expectedCommit !== "string" ||
    typeof runId !== "string" ||
    typeof runAttempt !== "string"
  ) {
    throw new Error("GPU-free preflight workflow identifiers are missing");
  }
  const candidate = parseCloudRunCandidateEvidence(
    JSON.parse(readFileSync(path.resolve(candidatePath), "utf8")),
  );
  const releaseInputs = parseStagingReleaseInputs(process.env);
  const plan = createStagingBootstrapPreflightPlan({
    bootstrapRequestId: createUlid(),
    commit: candidate.commit,
    executionHandle: randomBytes(32).toString("base64url"),
    expectedCommit,
    orchestratorOrigin: process.env.SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN,
    r2Host: releaseInputs.r2Host,
    runAttempt,
    runId,
    runtimeServiceAccount: releaseInputs.runtimeServiceAccount,
    workerImage: candidate.workerImage,
  });
  await requireStagingZero(plan);
  let creationAttempted = false;
  try {
    const environment = Object.entries(plan.environment)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    const labels = Object.entries(plan.labels)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    creationAttempted = true;
    await runGcloud([
      "run",
      "jobs",
      "create",
      plan.jobId,
      ...common(plan),
      `--image=${plan.workerImage}`,
      `--service-account=${plan.runtimeServiceAccount}`,
      "--command=python",
      `--args=-m,${plan.module}`,
      `--set-env-vars=${environment}`,
      "--cpu=1",
      "--memory=512Mi",
      "--tasks=1",
      "--parallelism=1",
      "--max-retries=0",
      "--task-timeout=60s",
      "--execution-environment=gen2",
      "--binary-authorization=default",
      `--labels=${labels}`,
    ]);
    const described = await gcloudJson(["run", "jobs", "describe", plan.jobId, ...common(plan)]);
    verifyStagingBootstrapPreflightJob(plan, described);
    await runGcloud(["run", "jobs", "execute", plan.jobId, ...common(plan), "--wait"], {
      timeoutMs: 5 * 60_000,
    });
    const executions = await gcloudJson([
      "run",
      "jobs",
      "executions",
      "list",
      ...common(plan),
      `--job=${plan.jobId}`,
      "--limit=2",
    ]);
    if (!Array.isArray(executions) || executions.length !== 1) {
      throw new Error("GPU-free preflight did not create exact one Execution");
    }
    const filter = [
      'resource.type="cloud_run_job"',
      `resource.labels.job_name="${plan.jobId}"`,
      `(textPayload="${plan.successMarker}" OR textPayload="${plan.failureMarker}")`,
    ].join(" AND ");
    const markers = await gcloudJson([
      "logging",
      "read",
      filter,
      `--project=${plan.projectId}`,
      "--freshness=30m",
      "--limit=2",
    ]);
    const evidence = verifyStagingBootstrapPreflightMarkers(plan, markers);
    console.log(
      JSON.stringify({
        ...evidence,
        binaryAuthorization: true,
        cpu: 1,
        exactExecutionSent: 1,
        gpu: 0,
        maxRetries: 0,
        memory: "512Mi",
        taskCount: 1,
      }),
    );
  } finally {
    if (creationAttempted) {
      await runGcloud(["run", "jobs", "delete", plan.jobId, ...common(plan)], { optional: true });
      await waitForStagingZero(plan);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "GPU-free bootstrap preflight failed");
  process.exitCode = 1;
}
