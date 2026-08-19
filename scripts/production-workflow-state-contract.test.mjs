import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyProductionWorkflowStateContract } from "./production-workflow-state-contract.mjs";

const workflow = readFileSync(".github/workflows/deploy-production-candidate.yml", "utf8");

test("binds every production input and policy producer before external access", () => {
  assert.deepEqual(verifyProductionWorkflowStateContract(workflow), {
    policyProducer: "Verify accepted production environment policy before external access",
    secretReferences: 6,
    variableReferences: 15,
  });
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
