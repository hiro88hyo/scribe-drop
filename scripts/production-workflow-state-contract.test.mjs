import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyProductionWorkflowStateContract } from "./production-workflow-state-contract.mjs";

const workflow = readFileSync(".github/workflows/deploy-production-candidate.yml", "utf8");

test("binds every production input and policy producer before external access", () => {
  assert.deepEqual(verifyProductionWorkflowStateContract(workflow), {
    finalizeMutationCount: 4,
    finalizePrefixStateCount: 5,
    policyProducer: "Verify accepted production environment policy before external access",
    secretReferences: 6,
    variableReferences: 15,
  });
});

test("rejects each missing finalize state-machine prerequisite", () => {
  for (const required of [
    "PRODUCTION_FINALIZE_ENTRY_STAGE: ${{ inputs.finalize_entry_stage }}",
    "SCRIBE_DROP_CLOUD_RUN_SMOKE_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "SCRIBE_DROP_CLOUD_RUN_OPERATIONAL_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "PRODUCTION_SMOKE_JOB_ID: ${{ inputs.production_smoke_job_id }}",
    "SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    'SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS: "1"',
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "FINALIZE_ENTRY_STAGE: ${{ inputs.finalize_entry_stage }}",
  ]) {
    const regressed = workflow.replaceAll(required, "REMOVED_FINALIZE_CONTRACT_VALUE");
    assert.notEqual(regressed, workflow);
    assert.throws(() => verifyProductionWorkflowStateContract(regressed), /incomplete/u, required);
  }
});

test("rejects a retry-unstable operational epoch", () => {
  const regressed = workflow.replaceAll(
    "phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "phase16-operational-${{ inputs.candidate_commit_sha }}-${{ github.run_id }}",
  );
  assert.notEqual(regressed, workflow);
  assert.throws(
    () => verifyProductionWorkflowStateContract(regressed),
    /incomplete|stable across finalize retries/u,
  );
});

test("rejects the previous cutover policy producer omission", () => {
  const producer =
    /\n[ ]{6}- name: Verify accepted production environment policy before external access[\s\S]*?(?=\n[ ]{6}- name:)/u;
  const regressed = workflow.replace(producer, "");
  assert.notEqual(regressed, workflow);
  assert.throws(() => verifyProductionWorkflowStateContract(regressed), /missing or out of order/u);
});

test("rejects an unbound staging run policy input", () => {
  const regressed = workflow.replace(
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1\n          STAGING_RUN_ID: ${{ inputs.staging_run_id }}",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1\n          EXPECTED_STAGING_RUN_ID: ${{ inputs.staging_run_id }}",
  );
  assert.notEqual(regressed, workflow);
  assert.throws(() => verifyProductionWorkflowStateContract(regressed), /producer is incomplete/u);
});

test("requires the dedicated Pages token for the final Wrangler read-back", () => {
  const regressed = workflow.replace(
    'CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PAGES_API_TOKEN}" \\\n            pnpm exec wrangler pages deployment list',
    "pnpm exec wrangler pages deployment list",
  );
  assert.notEqual(regressed, workflow);
  assert.throws(
    () => verifyProductionWorkflowStateContract(regressed),
    /external preflight is incomplete or out of order/u,
  );
});

test("rejects an unreviewed Environment variable or secret reference", () => {
  assert.throws(
    () =>
      verifyProductionWorkflowStateContract(
        workflow.replace(
          "env:\n  VOLTA_FEATURE_PNPM",
          "env:\n  UNREVIEWED: ${{ vars.UNREVIEWED }}\n  VOLTA_FEATURE_PNPM",
        ),
      ),
    /vars references/u,
  );
  assert.throws(
    () =>
      verifyProductionWorkflowStateContract(
        workflow.replace(
          "env:\n  VOLTA_FEATURE_PNPM",
          "env:\n  UNREVIEWED: ${{ secrets.UNREVIEWED }}\n  VOLTA_FEATURE_PNPM",
        ),
      ),
    /secrets references/u,
  );
});
