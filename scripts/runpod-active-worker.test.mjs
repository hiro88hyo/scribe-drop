import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cooldownStagingRunpodCandidate,
  prewarmStagingRunpodCandidate,
  STAGING_RUNPOD_PREWARM_TIMEOUT_MS,
} from "./runpod-active-worker.mjs";
import { createRunpodStagingPlan } from "./runpod-environment-config.mjs";

const endpointId = "endpoint_staging";
const templateId = "template_candidate";
const plan = createRunpodStagingPlan({
  accountId: "a".repeat(32),
  gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090",
  image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  registryAuthId: "registry_staging",
});
const input = { endpointId, plan, templateId };

function endpoint(workersMin, workerReady = false) {
  return {
    executionTimeoutMs: plan.endpoint.executionTimeoutSeconds * 1_000,
    flashBootType: "OFF",
    gpuCount: plan.endpoint.gpuCount,
    gpuTypeIds: plan.endpoint.gpuTypeIds,
    id: endpointId,
    idleTimeout: plan.endpoint.idleTimeoutSeconds,
    minCudaVersion: plan.endpoint.minCudaVersion,
    modelReferences: [],
    name: plan.endpoint.name,
    networkVolumeIds: [],
    scalerType: plan.endpoint.scalerType,
    scalerValue: plan.endpoint.scalerValue,
    templateId,
    workers:
      workersMin === 1
        ? [
            {
              desiredStatus: "RUNNING",
              imageName: plan.template.image,
              templateId,
              ...(workerReady ? { id: "worker_candidate" } : {}),
            },
          ]
        : [],
    workersMax: plan.endpoint.workersMax,
    workersMin,
  };
}

function health(state) {
  return {
    workers: {
      idle: 0,
      initializing: state === "initializing" ? 1 : 0,
      ready: state === "ready" ? 1 : 0,
      running: 0,
      throttled: 0,
      unhealthy: 0,
    },
  };
}

function capacity(gpuTypeIds = plan.endpoint.gpuTypeIds) {
  return {
    gpuTypeIds,
    id: endpointId,
  };
}

test("prewarms the exact candidate before returning", async () => {
  let workersMin = 0;
  let healthReads = 0;
  const mutations = [];
  await prewarmStagingRunpodCandidate(input, {
    getCapacity() {
      return Promise.resolve(capacity());
    },
    getEndpoint() {
      return Promise.resolve(endpoint(workersMin, healthReads > 1));
    },
    getHealth() {
      healthReads += 1;
      return Promise.resolve(health(healthReads > 1 ? "ready" : "initializing"));
    },
    now: () => healthReads * 15_000,
    setWorkersMin(request) {
      mutations.push(request);
      workersMin = request.workersMin;
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
  });

  assert.equal(workersMin, 1);
  assert.deepEqual(mutations, [{ endpointId, workersMin: 1 }]);
  assert.equal(healthReads, 2);
});

test("uses exact read-back when the prewarm mutation response is lost", async () => {
  let workersMin = 0;
  let requests = 0;
  await prewarmStagingRunpodCandidate(input, {
    getCapacity() {
      return Promise.resolve(capacity());
    },
    getEndpoint() {
      return Promise.resolve(endpoint(workersMin, workersMin === 1));
    },
    getHealth() {
      return Promise.resolve(health("ready"));
    },
    now: () => 0,
    setWorkersMin(request) {
      requests += 1;
      workersMin = request.workersMin;
      return Promise.reject(new Error("provider response containing sensitive data"));
    },
  });

  assert.equal(workersMin, 1);
  assert.equal(requests, 1);
});

test("restores scale-to-zero when no candidate worker becomes ready", async () => {
  let currentTime = 0;
  let workersMin = 0;
  const mutations = [];
  await assert.rejects(
    prewarmStagingRunpodCandidate(input, {
      getCapacity() {
        return Promise.resolve(capacity());
      },
      getEndpoint() {
        return Promise.resolve(endpoint(workersMin));
      },
      getHealth() {
        return Promise.resolve(health("initializing"));
      },
      now: () => currentTime,
      setWorkersMin(request) {
        mutations.push(request);
        workersMin = request.workersMin;
        return Promise.resolve();
      },
      sleep(milliseconds) {
        currentTime += milliseconds;
        return Promise.resolve();
      },
    }),
    /prewarm failed; scale-to-zero was restored/u,
  );

  assert.equal(currentTime, STAGING_RUNPOD_PREWARM_TIMEOUT_MS);
  assert.equal(workersMin, 0);
  assert.deepEqual(mutations, [
    { endpointId, workersMin: 1 },
    { endpointId, workersMin: 0 },
  ]);
});

test("rejects capacity drift before requesting an active worker", async () => {
  let mutations = 0;
  await assert.rejects(
    prewarmStagingRunpodCandidate(input, {
      getCapacity() {
        return Promise.resolve(capacity(["NVIDIA L4"]));
      },
      getEndpoint() {
        return Promise.resolve(endpoint(0));
      },
      getHealth() {
        throw new Error("Health must not be read after capacity drift");
      },
      setWorkersMin() {
        mutations += 1;
        return Promise.resolve();
      },
    }),
    /prewarm failed; scale-to-zero was restored/u,
  );
  assert.equal(mutations, 0);
});

test("cooldown is idempotent when scale-to-zero is already restored", async () => {
  let mutations = 0;
  await cooldownStagingRunpodCandidate(input, {
    getEndpoint() {
      return Promise.resolve(endpoint(0));
    },
    setWorkersMin() {
      mutations += 1;
      return Promise.resolve();
    },
  });
  assert.equal(mutations, 0);
});

test("normalizes the provider's null worker list after scale-to-zero", async () => {
  let mutations = 0;
  await cooldownStagingRunpodCandidate(input, {
    getEndpoint() {
      return Promise.resolve({ ...endpoint(0), workers: null });
    },
    setWorkersMin() {
      mutations += 1;
      return Promise.resolve();
    },
  });
  assert.equal(mutations, 0);
});

test("normalizes an omitted worker minimum to fixed scale-to-zero", async () => {
  let mutations = 0;
  const current = endpoint(0);
  delete current.workersMin;
  await cooldownStagingRunpodCandidate(input, {
    getEndpoint() {
      return Promise.resolve(current);
    },
    setWorkersMin() {
      mutations += 1;
      return Promise.resolve();
    },
  });
  assert.equal(mutations, 0);
});

test("cooldown restores and verifies the active worker minimum", async () => {
  let workersMin = 1;
  await cooldownStagingRunpodCandidate(input, {
    getEndpoint() {
      return Promise.resolve(endpoint(workersMin, true));
    },
    setWorkersMin(request) {
      workersMin = request.workersMin;
      return Promise.resolve();
    },
  });
  assert.equal(workersMin, 0);
});

test("cooldown is not blocked by candidate template drift", async () => {
  let workersMin = 1;
  await cooldownStagingRunpodCandidate(input, {
    getEndpoint() {
      return Promise.resolve({
        ...endpoint(workersMin, true),
        templateId: "template_drifted",
        workers: [
          {
            desiredStatus: "RUNNING",
            imageName: "ghcr.io/example/drifted@sha256:deadbeef",
            templateId: "template_drifted",
          },
        ],
      });
    },
    setWorkersMin(request) {
      workersMin = request.workersMin;
      return Promise.resolve();
    },
  });
  assert.equal(workersMin, 0);
});

test("cooldown refuses to mutate a mismatched endpoint identity", async () => {
  let mutations = 0;
  await assert.rejects(
    cooldownStagingRunpodCandidate(input, {
      getEndpoint() {
        return Promise.resolve({
          ...endpoint(1, true),
          id: "endpoint_other",
        });
      },
      setWorkersMin() {
        mutations += 1;
        return Promise.resolve();
      },
    }),
    /cooldown endpoint identity did not match/u,
  );
  assert.equal(mutations, 0);
});

test("cooldown rejects a lost mutation that was not applied", async () => {
  let reads = 0;
  await assert.rejects(
    cooldownStagingRunpodCandidate(input, {
      getEndpoint() {
        reads += 1;
        return Promise.resolve(endpoint(1, true));
      },
      setWorkersMin() {
        return Promise.reject(new Error("provider response containing sensitive data"));
      },
    }),
    /scale-to-zero read-back did not match/u,
  );
  assert.equal(reads, 2);
});

test("reports rollback failure without treating prewarm as successful", async () => {
  let currentTime = 0;
  let workersMin = 0;
  await assert.rejects(
    prewarmStagingRunpodCandidate(input, {
      getCapacity() {
        return Promise.resolve(capacity());
      },
      getEndpoint() {
        return Promise.resolve(endpoint(workersMin));
      },
      getHealth() {
        return Promise.resolve(health("initializing"));
      },
      now: () => currentTime,
      setWorkersMin(request) {
        if (request.workersMin === 1) {
          workersMin = 1;
        }
        return Promise.resolve();
      },
      sleep(milliseconds) {
        currentTime += milliseconds;
        return Promise.resolve();
      },
    }),
    /prewarm failed and scale-to-zero rollback failed/u,
  );
  assert.equal(workersMin, 1);
});
