import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import { verifyStagingPaidReadiness } from "./staging-cloud-run-paid-readiness.mjs";

const [candidatePath] = process.argv.slice(2);
if (candidatePath === undefined || process.argv.length !== 3) {
  throw new Error("Usage: verify-staging-cloud-run-paid-readiness <candidate-evidence>");
}

function requireValue(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function readQuota() {
  const child = spawn(
    "gcloud",
    [
      "quotas",
      "info",
      "describe",
      "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion",
      "--service=run.googleapis.com",
      "--project=scribe-drop",
      "--format=json",
    ],
    { env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
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
  if (exitCode !== 0) throw new Error("Staging L4 quota read failed");
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Staging L4 quota response was invalid");
  }
}

const candidate = parseCloudRunCandidateEvidence(
  JSON.parse(readFileSync(path.resolve(candidatePath), "utf8")),
);
if (candidate.commit !== process.env.EXPECTED_COMMIT_SHA) {
  throw new Error("Cloud Run candidate commit does not match");
}
const orchestratorOrigin = requireValue(
  process.env.SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN,
  /^https:\/\/[a-z0-9.-]+$/u,
  "Staging Orchestrator origin",
);
const r2Host = requireValue(
  process.env.SCRIBE_DROP_STAGING_R2_HOST,
  /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u,
  "Staging R2 host",
);
const runtimeServiceAccount = requireValue(
  process.env.SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT,
  /^gpu-runtime@scribe-drop\.iam\.gserviceaccount\.com$/u,
  "Staging runtime service account",
);

try {
  const { createFixedJobManifest } = await import("../apps/gpu-controller/dist/index.js");
  const manifest = createFixedJobManifest(
    {
      environment: "staging",
      imageDigest: candidate.workerImage,
      orchestratorOrigin,
      projectId: "scribe-drop",
      resultHost: r2Host,
      runtimeServiceAccount,
      sourceHost: r2Host,
    },
    "A".repeat(43),
    "00000000000000000000000000",
  );
  console.log(
    JSON.stringify(
      verifyStagingPaidReadiness({
        manifest,
        quota: await readQuota(),
        workerImage: candidate.workerImage,
      }),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging paid readiness failed");
  process.exitCode = 1;
}
