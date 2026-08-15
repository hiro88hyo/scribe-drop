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
    recovery: {
      admission: "active",
      mode: "synthetic-shadow",
      policy: "runpod_serverless_v1",
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
