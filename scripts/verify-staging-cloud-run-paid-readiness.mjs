import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import { readStagingL4Quota } from "./staging-cloud-run-quota-client.mjs";
import { verifyStagingPaidReadiness } from "./staging-cloud-run-paid-readiness.mjs";

const [candidatePath] = process.argv.slice(2);
if (candidatePath === undefined || process.argv.length !== 3) {
  throw new Error("Usage: verify-staging-cloud-run-paid-readiness <candidate-evidence>");
}

function requireValue(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
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
        quota: await readStagingL4Quota(process.env.GOOGLE_OAUTH_ACCESS_TOKEN),
        workerImage: candidate.workerImage,
      }),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging paid readiness failed");
  process.exitCode = 1;
}
