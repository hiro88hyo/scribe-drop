import process from "node:process";

import { verifyRunpodReleaseReadiness } from "./runpod-template-api.mjs";

const environment = process.argv[2];
const releaseBranchPattern =
  /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

function retryLogger({ attempt, command, maximumAttempts }) {
  console.warn(
    `Retrying read-only RunPod REST ${command} (${String(attempt)}/${String(maximumAttempts)})`,
  );
}

try {
  if (environment !== "staging" || process.argv.length !== 3) {
    throw new Error("Usage: verify-runpod-release-readiness staging");
  }
  if (process.env["GITHUB_ACTIONS"] !== "true") {
    throw new Error("RunPod release readiness is restricted to GitHub Actions");
  }
  const workflowRef = String(process.env["GITHUB_WORKFLOW_REF"] ?? "");
  const isCandidateWorkflow = workflowRef.includes("/publish-runpod-worker.yml@");
  const isReleaseCiWorkflow =
    workflowRef.includes("/ci.yml@") &&
    process.env["GITHUB_EVENT_NAME"] === "pull_request" &&
    releaseBranchPattern.test(String(process.env["GITHUB_HEAD_REF"] ?? ""));
  if (!isCandidateWorkflow && !isReleaseCiWorkflow) {
    throw new Error("RunPod release readiness workflow identity is invalid");
  }

  const apiKey = process.env["RUNPOD_API_KEY"];
  const endpointId = process.env["SCRIBE_DROP_STAGING_RUNPOD_ENDPOINT_ID"];
  await verifyRunpodReleaseReadiness(
    { apiKey, endpointId },
    {
      onRetry: retryLogger,
    },
  );
  console.log("Verified read-only staging RunPod release readiness.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "RunPod release readiness verification failed",
  );
  process.exitCode = 1;
}
