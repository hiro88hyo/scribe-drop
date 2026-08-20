import assert from "node:assert/strict";
import test from "node:test";

import {
  stagingSmokeCostReview,
  stagingSmokeWorstCaseJpy,
  verifyStagingL4Quota,
  verifyStagingPaidManifest,
  verifyStagingPaidReadiness,
} from "./staging-cloud-run-paid-readiness.mjs";

const workerImage = `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"a".repeat(64)}`;

function quota() {
  return {
    containerType: "PROJECT",
    dimensions: ["region"],
    dimensionsInfos: [
      {
        applicableLocations: ["asia-southeast1"],
        details: { value: "3" },
        dimensions: { region: "asia-southeast1" },
      },
    ],
    metric: "run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy",
    metricUnit: "1",
    name:
      "projects/601035271372/locations/global/services/run.googleapis.com/quotaInfos/" +
      "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion",
    quotaId: "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion",
    service: "run.googleapis.com",
  };
}

function manifest() {
  return {
    binaryAuthorization: { useDefault: true },
    labels: {
      "scribe-drop-environment": "staging",
      "scribe-drop-policy": "cloud-run-jobs-l4-v1",
    },
    template: {
      parallelism: 1,
      taskCount: 1,
      template: {
        containers: [
          {
            command: ["python", "-m", "scribe_drop_worker.one_shot"],
            env: [
              { name: "APP_ENV", value: "staging" },
              { name: "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID", value: "request" },
              { name: "SCRIBE_DROP_EXECUTION_HANDLE", value: "handle" },
              { name: "SCRIBE_DROP_EXECUTION_POLICY", value: "cloud_run_jobs_l4_v1" },
              { name: "SCRIBE_DROP_ORCHESTRATOR_ORIGIN", value: "https://example.com/" },
              {
                name: "SCRIBE_DROP_IDENTITY_AUDIENCE",
                value: "https://example.com/internal/cloud-run/bootstrap",
              },
              { name: "SCRIBE_DROP_SOURCE_HOST", value: "source.example" },
              { name: "SCRIBE_DROP_RESULT_HOST", value: "result.example" },
            ],
            image: workerImage,
            name: "worker",
            resources: { limits: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" } },
            volumeMounts: [{ mountPath: "/tmp", name: "scratch" }],
          },
        ],
        executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
        gpuZonalRedundancyDisabled: true,
        maxRetries: 0,
        nodeSelector: { accelerator: "nvidia-l4" },
        serviceAccount: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
        timeout: "3300s",
        volumes: [{ emptyDir: { medium: "MEMORY", sizeLimit: "3Gi" }, name: "scratch" }],
      },
    },
  };
}

test("retains the already reviewed Phase 15 233 JPY cost bound", () => {
  assert.equal(stagingSmokeWorstCaseJpy(), 233);
  assert.equal(stagingSmokeWorstCaseJpy(stagingSmokeCostReview), 233);
});

test("requires exact Singapore no-zonal L4 quota for one execution", () => {
  assert.deepEqual(verifyStagingL4Quota(quota()), {
    effectiveLimit: 3,
    exactOneFits: true,
    metric: "run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy",
    region: "asia-southeast1",
  });
  assert.throws(() => verifyStagingL4Quota({ ...quota(), quotaId: "another-quota" }));
  assert.throws(() =>
    verifyStagingL4Quota({
      ...quota(),
      dimensionsInfos: [
        {
          applicableLocations: ["asia-southeast1"],
          details: { value: "0" },
          dimensions: { region: "asia-southeast1" },
        },
      ],
    }),
  );
});

test("requires the exact Phase 15 paid manifest and cost ceiling", () => {
  assert.deepEqual(
    verifyStagingPaidReadiness({ manifest: manifest(), quota: quota(), workerImage }),
    {
      authorizationJpy: 250,
      costJpy: 233,
      manifest: {
        cpu: 4,
        gpu: 1,
        maxRetries: 0,
        memoryGiB: 16,
        parallelism: 1,
        taskCount: 1,
        timeoutSeconds: 3300,
      },
      quota: {
        effectiveLimit: 3,
        exactOneFits: true,
        metric: "run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy",
        region: "asia-southeast1",
      },
    },
  );
  assert.throws(() =>
    verifyStagingPaidManifest(
      {
        ...manifest(),
        template: { ...manifest().template, taskCount: 2 },
      },
      workerImage,
    ),
  );
  const drifted = manifest();
  drifted.template.template.containers[0].resources.limits["nvidia.com/gpu"] = "2";
  assert.throws(() => verifyStagingPaidManifest(drifted, workerImage));
});
