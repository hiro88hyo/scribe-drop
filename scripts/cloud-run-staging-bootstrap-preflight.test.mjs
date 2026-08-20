import assert from "node:assert/strict";
import test from "node:test";

import {
  createStagingBootstrapPreflightPlan,
  verifyStagingBootstrapPreflightJob,
  verifyStagingBootstrapPreflightMarkers,
} from "./cloud-run-staging-bootstrap-preflight.mjs";

const input = {
  bootstrapRequestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  commit: "a".repeat(40),
  executionHandle: "b".repeat(43),
  expectedCommit: "a".repeat(40),
  orchestratorOrigin: "https://hooks-staging.example.invalid",
  r2Host: `${"c".repeat(32)}.r2.cloudflarestorage.com`,
  runAttempt: "2",
  runId: "31884590955",
  runtimeServiceAccount: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
  workerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"d".repeat(64)}`,
};

function job(plan, overrides = {}) {
  return {
    metadata: {
      annotations: { "run.googleapis.com/binary-authorization": "default" },
      labels: plan.labels,
      name: plan.jobId,
    },
    spec: {
      template: {
        metadata: { annotations: { "run.googleapis.com/execution-environment": "gen2" } },
        spec: {
          parallelism: 1,
          taskCount: 1,
          template: {
            spec: {
              containers: [
                {
                  args: ["-m", plan.module],
                  command: ["python"],
                  env: Object.entries(plan.environment).map(([name, value]) => ({ name, value })),
                  image: plan.workerImage,
                  resources: { limits: { cpu: "1", memory: "512Mi" } },
                },
              ],
              maxRetries: 0,
              serviceAccountName: plan.runtimeServiceAccount,
              timeoutSeconds: "60",
            },
          },
        },
      },
    },
    ...overrides,
  };
}

test("fixes a unique candidate-bound GPU-zero preflight plan", () => {
  const plan = createStagingBootstrapPreflightPlan(input);
  assert.equal(plan.jobId, "sd-stg-pf-aaaaaaa-31884590955-2");
  assert.equal(plan.environment.APP_ENV, "staging");
  assert.equal(plan.environment.SCRIBE_DROP_EXECUTION_POLICY, "cloud_run_jobs_l4_v1");
  assert.equal(Object.keys(plan.environment).length, 8);
  assert.deepEqual(verifyStagingBootstrapPreflightJob(plan, job(plan)), {
    cpu: 1,
    gpu: 0,
    maxRetries: 0,
    memory: "512Mi",
    taskCount: 1,
  });
});

test("accepts only the exact EXECUTION_NOT_FOUND marker", () => {
  const plan = createStagingBootstrapPreflightPlan(input);
  assert.deepEqual(
    verifyStagingBootstrapPreflightMarkers(plan, [{ textPayload: `${plan.successMarker}\n` }]),
    { failedMarkers: 0, okMarkers: 1, result: "EXECUTION_NOT_FOUND" },
  );
  assert.throws(
    () =>
      verifyStagingBootstrapPreflightMarkers(plan, [
        { textPayload: plan.successMarker },
        { textPayload: plan.failureMarker },
      ]),
    /marker evidence/u,
  );
  assert.throws(
    () =>
      verifyStagingBootstrapPreflightMarkers(plan, [
        { textPayload: plan.successMarker },
        { textPayload: plan.successMarker },
      ]),
    /marker evidence/u,
  );
});

test("rejects candidate drift, GPU presence, retries, and extra environment", () => {
  assert.throws(
    () => createStagingBootstrapPreflightPlan({ ...input, expectedCommit: "e".repeat(40) }),
    /does not match/u,
  );
  const plan = createStagingBootstrapPreflightPlan(input);
  const gpuJob = job(plan);
  gpuJob.spec.template.spec.template.spec.containers[0].resources.limits["nvidia.com/gpu"] = "1";
  assert.throws(() => verifyStagingBootstrapPreflightJob(plan, gpuJob), /does not match/u);
  const retryJob = job(plan);
  retryJob.spec.template.spec.template.spec.maxRetries = 1;
  assert.throws(() => verifyStagingBootstrapPreflightJob(plan, retryJob), /does not match/u);
  const extraEnvironmentJob = job(plan);
  extraEnvironmentJob.spec.template.spec.template.spec.containers[0].env.push({
    name: "UNREVIEWED",
    value: "1",
  });
  assert.throws(
    () => verifyStagingBootstrapPreflightJob(plan, extraEnvironmentJob),
    /does not match/u,
  );
});
