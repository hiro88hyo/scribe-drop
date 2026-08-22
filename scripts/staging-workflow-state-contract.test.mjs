import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyStagingWorkflowStateContract } from "./staging-workflow-state-contract.mjs";

const workflow = readFileSync(".github/workflows/deploy-staging-candidate.yml", "utf8");

function regressStep(contents, stepName, required) {
  const marker = `      - name: ${stepName}\n`;
  const start = contents.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`);
  const remainder = contents.slice(start + marker.length);
  const nextStep = remainder.search(/^ {6}- name: /mu);
  const end = nextStep === -1 ? contents.length : start + marker.length + nextStep;
  const selected = contents.slice(start, end);
  const regressed = selected.replace(required, "");
  assert.notEqual(regressed, selected, `missing required source in ${stepName}`);
  return `${contents.slice(0, start)}${regressed}${contents.slice(end)}`;
}

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

test("rejects recovery read-back without complete staging configuration rendering", async () => {
  const regressed = workflow.replace(
    /(name: Verify recovered staging safety without issuing acceptance[\s\S]*?)pnpm run cloudflare:config:staging\n/u,
    "$1pnpm run cloudflare:config:staging:orchestrator\n",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /must render the complete staging configuration before full read-back/u,
  );
});

test("rejects a post-cleanup controller disable without the exact consumed smoke epoch", async () => {
  const regressed = workflow.replace(
    / {10}SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: phase16-smoke-\$\{\{ inputs\.candidate_commit_sha \|\| github\.sha \}\}-\$\{\{ github\.run_id \}\}\n/u,
    "",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /post-cleanup controller disable SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH must be phase16-smoke/u,
  );
});

test("rejects an initial disabled controller deployment without an explicit disabled epoch", async () => {
  const regressed = workflow.replace(
    / {10}SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: disabled\n/u,
    "",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /initial disabled controller deployment SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH must be disabled/u,
  );
});

test("rejects exact-one authorization without the source-run-bound smoke epoch", async () => {
  const regressed = workflow.replace(
    '          SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH="phase16-smoke-${EXPECTED_COMMIT_SHA}-${GITHUB_RUN_ID}" \\\n',
    "",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /exact-one controller authorization must run SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH/u,
  );
});

test("rejects recovery without the source-run-bound recovery epoch", async () => {
  const regressed = workflow.replace(
    / {6}SCRIBE_DROP_CLOUD_RUN_RECOVERY_EPOCH: phase16-smoke-\$\{\{ inputs\.candidate_commit_sha \|\| github\.sha \}\}-\$\{\{ github\.run_id \}\}\n/u,
    "",
  );
  assert.notEqual(regressed, workflow);
  await assert.rejects(
    verifyStagingWorkflowStateContract(regressed),
    /recovery job SCRIBE_DROP_CLOUD_RUN_RECOVERY_EPOCH must be phase16-smoke/u,
  );
});

test("rejects every missing post-cleanup prerequisite before the next dispatch", async () => {
  for (const fixture of [
    {
      error: /post-acceptance RunPod restore CLOUDFLARE_API_TOKEN/u,
      required: "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
      step: "Restore RunPod selection while preserving the Cloud Run reaper",
    },
    {
      error: /final staging safety read-back GOOGLE_OAUTH_ACCESS_TOKEN/u,
      required:
        "          GOOGLE_OAUTH_ACCESS_TOKEN: ${{ steps.google-auth.outputs.access_token }}\n",
      step: "Verify final disabled zero state before issuing acceptance",
    },
    {
      error: /staging acceptance issuance EXPECTED_CLOUD_RUN_CANDIDATE_RUN_ID/u,
      required:
        "          EXPECTED_CLOUD_RUN_CANDIDATE_RUN_ID: ${{ inputs.cloud_run_candidate_run_id }}\n",
      step: "Issue short-lived staging acceptance",
    },
    {
      error: /staging acceptance upload uses/u,
      required:
        "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n",
      step: "Upload immutable staging acceptance",
    },
  ]) {
    await assert.rejects(
      verifyStagingWorkflowStateContract(regressStep(workflow, fixture.step, fixture.required)),
      fixture.error,
      fixture.step,
    );
  }
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
