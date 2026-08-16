import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyStagingWorkflowStateContract } from "./staging-workflow-state-contract.mjs";

const workflow = readFileSync(".github/workflows/deploy-staging-candidate.yml", "utf8");

test("accepts the reviewed staging state transition contract", async () => {
  assert.deepEqual(await verifyStagingWorkflowStateContract(workflow), {
    acceptedParity: {
      admission: "active",
      mode: "synthetic-shadow",
      policy: "cloud_run_jobs_l4_v1",
    },
    paidExecutions: 1,
    preAcceptanceDeployment: {
      admission: "active",
      mode: "synthetic-shadow",
      policy: "runpod_serverless_v1",
    },
    recoveredAcceptance: {
      liveParity: {
        admission: "active",
        mode: "synthetic-shadow",
        policy: "runpod_serverless_v1",
      },
      paidExecutions: 0,
    },
    recovery: {
      admission: "active",
      mode: "synthetic-shadow",
      policy: "runpod_serverless_v1",
    },
    workflowIdentity: {
      acceptance: 1,
      preflight: 2,
      "recover-acceptance": 1,
      "resume-acceptance-evidence": 1,
    },
  });
});

test("reproduces the rejected preflight RunPod parity regression", async () => {
  const regressed = workflow.replace(
    "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
    "SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: runpod_serverless_v1",
  );
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /preflight job policy must be cloud_run_jobs_l4_v1, received runpod_serverless_v1/u,
  );
});

test("rejects final Cloud Run policy as the recovered live resume baseline", async () => {
  const regressed = workflow.replace(
    /(name: Verify resumed live staging parity before any mutation[\s\S]*?SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY:) runpod_serverless_v1/u,
    "$1 cloud_run_jobs_l4_v1",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /resumed preflight live parity policy must be runpod_serverless_v1, received cloud_run_jobs_l4_v1/u,
  );
});

test("rejects a missing acceptance workflow branch identity before publish", async () => {
  const regressed = workflow.replace(
    /( {2}acceptance:\n[\s\S]*? {6}EXPECTED_COMMIT_SHA: \$\{\{ inputs\.candidate_commit_sha \|\| github\.sha \}\}\n) {6}EXPECTED_RELEASE_BRANCH: \$\{\{ github\.ref_name \}\}\n/u,
    "$1",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /acceptance job EXPECTED_RELEASE_BRANCH must be \$\{\{ github\.ref_name \}\}, received missing/u,
  );
});

test("rejects a missing recovery workflow branch identity before publish", async () => {
  const regressed = workflow.replace(
    /( {2}recover-acceptance:\n[\s\S]*? {6}EXPECTED_COMMIT_SHA: \$\{\{ inputs\.candidate_commit_sha \|\| github\.sha \}\}\n) {6}EXPECTED_RELEASE_BRANCH: \$\{\{ github\.ref_name \}\}\n/u,
    "$1",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /recover-acceptance job EXPECTED_RELEASE_BRANCH must be \$\{\{ github\.ref_name \}\}, received missing/u,
  );
});

test("rejects a workflow verifier whose run ID is not bound to dispatch input", async () => {
  const regressed = workflow.replace(
    "CLOUD_RUN_CANDIDATE_RUN_ID: ${{ inputs.cloud_run_candidate_run_id }}",
    "CLOUD_RUN_CANDIDATE_RUN_ID: untrusted-run-id",
  );
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /preflight job Validate release and candidate run identities CLOUD_RUN_CANDIDATE_RUN_ID must be \$\{\{ inputs\.cloud_run_candidate_run_id \}\}, received untrusted-run-id/u,
  );
});

test("checks workflow identity in every newly added verifier job", async () => {
  const regressed = workflow.replace(
    "jobs:\n",
    `jobs:
  auxiliary-verifier:
    env:
      EXPECTED_COMMIT_SHA: \${{ inputs.candidate_commit_sha || github.sha }}
    steps:
      - name: Verify an additional candidate
        env:
          CANDIDATE_RUN_ID: \${{ inputs.candidate_run_id }}
        run: |
          node scripts/verify-workflow-run.mjs \\
            "\${RUNNER_TEMP}/candidate-run.json" \\
            .github/workflows/publish-runpod-worker.yml \\
            "\${CANDIDATE_RUN_ID}"
`,
  );
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /auxiliary-verifier job EXPECTED_RELEASE_BRANCH must be \$\{\{ github\.ref_name \}\}, received missing/u,
  );
});
