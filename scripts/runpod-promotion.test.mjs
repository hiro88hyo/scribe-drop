import assert from "node:assert/strict";
import { test } from "node:test";

import {
  prepareRunpodProductionCapacity,
  promoteRunpodCandidate as promoteRunpodCandidateWithInputs,
  reconcileRunpodEndpointCapacity,
  verifyRunpodCandidateWorkerEvidence as verifyRunpodCandidateWorkerEvidenceWithInputs,
  verifyRunpodPromotionPreflight as verifyRunpodPromotionPreflightWithInputs,
} from "./runpod-promotion.mjs";
import {
  createRunpodProductionPlan,
  createRunpodStagingPlan,
} from "./runpod-environment-config.mjs";

const plan = createRunpodStagingPlan({
  accountId: "a".repeat(32),
  gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA RTX PRO 4500 Blackwell,NVIDIA GeForce RTX 4090",
  image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  registryAuthId: "registry_staging",
});
const productionPlan = createRunpodProductionPlan({
  accountId: "a".repeat(32),
  gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA RTX PRO 4500 Blackwell,NVIDIA GeForce RTX 4090",
  image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-production.example.invalid",
  registryAuthId: "registry_production",
});

function withTemplateList(input) {
  return {
    ...input,
    getEndpoint:
      input.getEndpoint ??
      (() =>
        Promise.resolve({
          compliance: plan.endpoint.compliance,
          dataCenterIds: plan.endpoint.dataCenterIds,
          gpuTypeIds: plan.endpoint.gpuTypeIds,
          id: input.endpointId,
        })),
    listTemplates:
      input.listTemplates ?? (() => input.runCli(["template", "list", "--type", "user"])),
    listGpus:
      input.listGpus ??
      (() =>
        Promise.resolve(
          plan.endpoint.gpuTypeIds.map((gpuId, index) => ({
            available: true,
            communityCloud: true,
            gpuId,
            secureCloud: true,
            stockStatus: index === 0 ? "High" : "Low",
          })),
        )),
  };
}

function verifyRunpodPromotionPreflight(input) {
  return verifyRunpodPromotionPreflightWithInputs(withTemplateList(input));
}

function verifyRunpodCandidateWorkerEvidence(input) {
  return verifyRunpodCandidateWorkerEvidenceWithInputs(withTemplateList(input));
}

function promoteRunpodCandidate(input) {
  let workersMax = plan.endpoint.workersMax;
  let dataCenterIds = Object.hasOwn(input, "initialDataCenterIds")
    ? input.initialDataCenterIds
    : plan.endpoint.dataCenterIds;
  const compliance = input.initialCompliance ?? plan.endpoint.compliance;
  let gpuTypeIds = input.initialGpuTypeIds ?? plan.endpoint.gpuTypeIds;
  const runCli = input.runCli;
  return promoteRunpodCandidateWithInputs(
    withTemplateList({
      ...input,
      getEndpoint:
        input.getEndpoint ??
        (() =>
          Promise.resolve({
            compliance,
            dataCenterIds,
            gpuTypeIds,
            id: input.endpointId,
          })),
      runCli(arguments_) {
        const result = runCli(arguments_);
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return {
            ...result,
            workers: workersMax === 0 ? [] : result.workers,
            workersMax,
          };
        }
        return result;
      },
      async setEndpointWorkersMax(request) {
        if (input.setEndpointWorkersMax !== undefined) {
          await input.setEndpointWorkersMax(request);
        }
        workersMax = request.workersMax;
      },
      async setEndpointDataCenters(request) {
        if (input.setEndpointDataCenters !== undefined) {
          await input.setEndpointDataCenters(request);
        }
        dataCenterIds = request.dataCenterIds;
      },
      async setEndpointGpuTypes(request) {
        if (input.setEndpointGpuTypes !== undefined) {
          await input.setEndpointGpuTypes(request);
        }
        gpuTypeIds = request.gpuTypeIds;
      },
    }),
  );
}

function template(id) {
  return {
    containerDiskInGb: plan.template.containerDiskInGb,
    containerRegistryAuthId: plan.template.registryAuthId,
    env: plan.template.environment,
    id,
    imageName: plan.template.image,
    isServerless: true,
    name: plan.template.name,
    ports: [],
    volumeInGb: 0,
  };
}

function endpoint(templateId, workers = [], workersMax = plan.endpoint.workersMax) {
  return {
    executionTimeoutMs: plan.endpoint.executionTimeoutSeconds * 1_000,
    flashBootType: "OFF",
    gpuCount: plan.endpoint.gpuCount,
    id: "endpoint_staging",
    idleTimeout: plan.endpoint.idleTimeoutSeconds,
    minCudaVersion: plan.endpoint.minCudaVersion,
    modelReferences: [],
    name: plan.endpoint.name,
    networkVolumeIds: [],
    scalerType: plan.endpoint.scalerType,
    scalerValue: plan.endpoint.scalerValue,
    templateId,
    workers,
    workersMax,
    workersMin: plan.endpoint.workersMin,
  };
}

function endpointForPlan(
  targetPlan,
  templateId,
  workers = [],
  workersMax = targetPlan.endpoint.workersMax,
) {
  return {
    executionTimeoutMs: targetPlan.endpoint.executionTimeoutSeconds * 1_000,
    flashBootType: "OFF",
    gpuCount: targetPlan.endpoint.gpuCount,
    id: "endpoint_production",
    idleTimeout: targetPlan.endpoint.idleTimeoutSeconds,
    minCudaVersion: targetPlan.endpoint.minCudaVersion,
    modelReferences: [],
    name: targetPlan.endpoint.name,
    networkVolumeIds: [],
    scalerType: targetPlan.endpoint.scalerType,
    scalerValue: targetPlan.endpoint.scalerValue,
    templateId,
    workers,
    workersMax,
    workersMin: targetPlan.endpoint.workersMin,
  };
}

function templateForPlan(targetPlan, id) {
  return {
    containerDiskInGb: targetPlan.template.containerDiskInGb,
    containerRegistryAuthId: targetPlan.template.registryAuthId,
    env: targetPlan.template.environment,
    id,
    imageName: targetPlan.template.image,
    isServerless: true,
    name: targetPlan.template.name,
    ports: [],
    volumeInGb: 0,
  };
}

function productionCapacity(overrides = {}) {
  return {
    compliance: productionPlan.endpoint.compliance,
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    id: "endpoint_production",
    ...overrides,
  };
}

function productionGpuInventory() {
  return productionPlan.endpoint.gpuTypeIds.map((gpuId) => ({
    available: true,
    communityCloud: true,
    gpuId,
    secureCloud: true,
    stockStatus: "Medium",
  }));
}

function productionHealth(overrides = {}) {
  return {
    jobs: { inProgress: 0, inQueue: 0 },
    workers: { idle: 0, initializing: 0, ready: 0, running: 0 },
    ...overrides,
  };
}

function productionPreparationHarness(options = {}) {
  let workersMax = productionPlan.endpoint.workersMax;
  let capacity = options.initialCapacity ?? productionCapacity();
  let healthReads = 0;
  const capacityRequests = [];
  const dataCenterRequests = [];
  const sleepDelays = [];
  const workerMaximums = [];
  return {
    capacityRequests,
    dataCenterRequests,
    get capacity() {
      return capacity;
    },
    input: {
      endpointId: "endpoint_production",
      environment: "production",
      getEndpoint() {
        return Promise.resolve(capacity);
      },
      getHealth() {
        healthReads += 1;
        return Promise.resolve(
          options.getHealth?.({ attempt: healthReads }) ?? options.health ?? productionHealth(),
        );
      },
      listGpus() {
        return Promise.resolve(productionGpuInventory());
      },
      plan: productionPlan,
      runCli(arguments_) {
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpointForPlan(productionPlan, "template_old", options.workers ?? [], workersMax);
        }
        throw new Error("Unexpected fake CLI call");
      },
      setEndpointDataCenters(request) {
        dataCenterRequests.push(request);
        capacity = {
          ...capacity,
          dataCenterIds: request.dataCenterIds,
        };
        return Promise.resolve();
      },
      setEndpointGpuTypes(request) {
        const combinedRequest = {
          ...request,
          dataCenterIds: capacity.dataCenterIds,
        };
        capacityRequests.push(combinedRequest);
        capacity = options.applyCapacity?.({
          capacity,
          index: capacityRequests.length,
          request: combinedRequest,
        }) ?? {
          ...capacity,
          gpuTypeIds: request.gpuTypeIds,
        };
        return Promise.resolve();
      },
      setEndpointWorkersMax(request) {
        workersMax = request.workersMax;
        workerMaximums.push(workersMax);
        return Promise.resolve();
      },
      sleep(milliseconds) {
        sleepDelays.push(milliseconds);
        return Promise.resolve();
      },
    },
    sleepDelays,
    workerMaximums,
    get workersMax() {
      return workersMax;
    },
  };
}

test("capacity reconciliation is idempotent for the exact fixed plan", async () => {
  let mutations = 0;
  const result = await reconcileRunpodEndpointCapacity({
    endpointId: "endpoint_staging",
    environment: "staging",
    getEndpoint() {
      return Promise.resolve({
        compliance: plan.endpoint.compliance,
        dataCenterIds: plan.endpoint.dataCenterIds,
        gpuTypeIds: plan.endpoint.gpuTypeIds,
        id: "endpoint_staging",
      });
    },
    plan,
    setEndpointDataCenters() {
      mutations += 1;
      return Promise.resolve();
    },
    setEndpointGpuTypes() {
      mutations += 1;
      return Promise.resolve();
    },
  });

  assert.deepEqual(result, {
    changed: false,
    endpointId: "endpoint_staging",
  });
  assert.equal(mutations, 0);
});

test("capacity reconciliation updates data centers before GPU types", async () => {
  let capacity = {
    compliance: plan.endpoint.compliance,
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    id: "endpoint_staging",
  };
  const mutations = [];
  const result = await reconcileRunpodEndpointCapacity({
    endpointId: "endpoint_staging",
    environment: "staging",
    getEndpoint() {
      return Promise.resolve(capacity);
    },
    plan,
    setEndpointDataCenters(request) {
      mutations.push({ kind: "data-centers", ...request });
      capacity = {
        ...capacity,
        dataCenterIds: request.dataCenterIds,
      };
      return Promise.resolve();
    },
    setEndpointGpuTypes(request) {
      mutations.push({ kind: "gpu-types", ...request });
      capacity = {
        ...capacity,
        gpuTypeIds: request.gpuTypeIds,
      };
      return Promise.resolve();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    endpointId: "endpoint_staging",
  });
  assert.deepEqual(mutations, [
    {
      dataCenterIds: [...plan.endpoint.dataCenterIds].sort(),
      endpointId: "endpoint_staging",
      kind: "data-centers",
    },
    {
      endpointId: "endpoint_staging",
      gpuTypeIds: plan.endpoint.gpuTypeIds,
      kind: "gpu-types",
    },
  ]);
});

test("capacity reconciliation waits for bounded control-plane convergence without resending", async () => {
  const previousCapacity = {
    compliance: plan.endpoint.compliance,
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    id: "endpoint_staging",
  };
  let capacity = previousCapacity;
  let gpuMutationAccepted = false;
  let readsAfterMutation = 0;
  let mutations = 0;
  const delays = [];
  const result = await reconcileRunpodEndpointCapacity({
    endpointId: "endpoint_staging",
    environment: "staging",
    getEndpoint() {
      if (!gpuMutationAccepted) {
        return Promise.resolve(capacity);
      }
      readsAfterMutation += 1;
      return Promise.resolve(
        readsAfterMutation < 3
          ? capacity
          : {
              ...capacity,
              gpuTypeIds: plan.endpoint.gpuTypeIds,
            },
      );
    },
    plan,
    setEndpointDataCenters(request) {
      mutations += 1;
      capacity = {
        ...capacity,
        dataCenterIds: request.dataCenterIds,
      };
      return Promise.resolve();
    },
    setEndpointGpuTypes() {
      mutations += 1;
      gpuMutationAccepted = true;
      return Promise.resolve();
    },
    sleep(milliseconds) {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    endpointId: "endpoint_staging",
  });
  assert.equal(mutations, 2);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("capacity reconciliation restores the exact previous capacity after failed read-back", async () => {
  const previousCapacity = {
    compliance: plan.endpoint.compliance,
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    id: "endpoint_staging",
  };
  let capacity = previousCapacity;
  const mutations = [];
  await assert.rejects(
    reconcileRunpodEndpointCapacity({
      endpointId: "endpoint_staging",
      environment: "staging",
      getEndpoint() {
        return Promise.resolve(capacity);
      },
      plan,
      sleep() {
        return Promise.resolve();
      },
      setEndpointDataCenters(request) {
        mutations.push({ kind: "data-centers", ...request });
        capacity = { ...capacity, dataCenterIds: request.dataCenterIds };
        return Promise.resolve();
      },
      setEndpointGpuTypes(request) {
        mutations.push({ kind: "gpu-types", ...request });
        return Promise.resolve();
      },
    }),
    /GPU update did not produce/u,
  );
  assert.deepEqual(mutations, [
    {
      dataCenterIds: [...plan.endpoint.dataCenterIds].sort(),
      endpointId: "endpoint_staging",
      kind: "data-centers",
    },
    {
      endpointId: "endpoint_staging",
      gpuTypeIds: plan.endpoint.gpuTypeIds,
      kind: "gpu-types",
    },
    {
      dataCenterIds: previousCapacity.dataCenterIds,
      endpointId: "endpoint_staging",
      kind: "data-centers",
    },
  ]);
  assert.deepEqual(capacity, previousCapacity);
});

test("capacity reconciliation reports when update and rollback both fail", async () => {
  let capacity = {
    compliance: plan.endpoint.compliance,
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    id: "endpoint_staging",
  };
  let mutations = 0;
  await assert.rejects(
    reconcileRunpodEndpointCapacity({
      endpointId: "endpoint_staging",
      environment: "staging",
      getEndpoint() {
        return Promise.resolve(capacity);
      },
      plan,
      sleep() {
        return Promise.resolve();
      },
      setEndpointDataCenters(request) {
        mutations += 1;
        if (mutations === 1) {
          capacity = {
            ...capacity,
            dataCenterIds: request.dataCenterIds,
            gpuTypeIds: ["NVIDIA L4"],
          };
        }
        return Promise.resolve();
      },
      setEndpointGpuTypes() {
        mutations += 1;
        return Promise.resolve();
      },
    }),
    /capacity update and rollback both failed/u,
  );
  assert.equal(mutations, 2);
});

test("preflights an idle endpoint without mutating when the candidate template is pending", async () => {
  const calls = [];
  const result = await verifyRunpodPromotionPreflight({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      calls.push(arguments_);
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") return [];
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_old");
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.deepEqual(result, {
    capacityUpdateRequired: false,
    candidateTemplateExists: false,
    candidateTemplatePortsRequireNormalization: false,
    endpointId: "endpoint_staging",
  });
  assert.equal(
    calls.some((arguments_) => arguments_.includes("update")),
    false,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.includes("create")),
    false,
  );
});

test("preflight validates an existing candidate template before any mutation", async () => {
  const result = await verifyRunpodPromotionPreflight({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template" && arguments_[1] === "get") {
        return template("template_new");
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_old");
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.candidateTemplateExists, true);
});

test("preflight reports legacy single-GPU capacity without mutating", async () => {
  const result = await verifyRunpodPromotionPreflight({
    endpointId: "endpoint_staging",
    environment: "staging",
    getEndpoint() {
      return Promise.resolve({
        compliance: plan.endpoint.compliance,
        dataCenterIds: plan.endpoint.dataCenterIds,
        gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
        id: "endpoint_staging",
      });
    },
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "template" && arguments_[1] === "list") return [];
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_old");
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.capacityUpdateRequired, true);
});

test("production preflight rejects capacity drift before any mutation", async () => {
  let mutations = 0;
  await assert.rejects(
    verifyRunpodPromotionPreflightWithInputs({
      endpointId: "endpoint_production",
      environment: "production",
      getEndpoint() {
        return Promise.resolve({
          compliance: productionPlan.endpoint.compliance,
          dataCenterIds: ["EU-RO-1"],
          gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
          id: "endpoint_production",
        });
      },
      listGpus() {
        return Promise.resolve(
          productionPlan.endpoint.gpuTypeIds.map((gpuId) => ({
            available: true,
            communityCloud: true,
            gpuId,
            secureCloud: true,
            stockStatus: "Medium",
          })),
        );
      },
      listTemplates() {
        return Promise.resolve([]);
      },
      plan: productionPlan,
      runCli(arguments_) {
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpointForPlan(productionPlan, "template_old");
        }
        mutations += 1;
        throw new Error("Unexpected mutating CLI call");
      },
    }),
    /must match the fixed plan before promotion/u,
  );
  assert.equal(mutations, 0);
});

test("production promotion rejects capacity drift before draining workers", async () => {
  let mutations = 0;
  await assert.rejects(
    promoteRunpodCandidateWithInputs({
      endpointId: "endpoint_production",
      environment: "production",
      getEndpoint() {
        return Promise.resolve({
          compliance: productionPlan.endpoint.compliance,
          dataCenterIds: ["EU-RO-1"],
          gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
          id: "endpoint_production",
        });
      },
      listGpus() {
        return Promise.resolve(
          productionPlan.endpoint.gpuTypeIds.map((gpuId) => ({
            available: true,
            communityCloud: true,
            gpuId,
            secureCloud: true,
            stockStatus: "Medium",
          })),
        );
      },
      listTemplates() {
        return Promise.resolve([{ id: "template_new", name: productionPlan.template.name }]);
      },
      plan: productionPlan,
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return templateForPlan(productionPlan, "template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpointForPlan(productionPlan, "template_old");
        }
        throw new Error("Unexpected fake CLI call");
      },
      setEndpointDataCenters() {
        mutations += 1;
        return Promise.resolve();
      },
      setEndpointGpuTypes() {
        mutations += 1;
        return Promise.resolve();
      },
      setEndpointWorkersMax() {
        mutations += 1;
        return Promise.resolve();
      },
    }),
    /must match the fixed plan before promotion/u,
  );
  assert.equal(mutations, 0);
});

test("production capacity preparation drains, reconciles once, and restores workers", async () => {
  const harness = productionPreparationHarness();
  const result = await prepareRunpodProductionCapacity(harness.input);

  assert.deepEqual(result, {
    changed: true,
    endpointId: "endpoint_production",
  });
  assert.equal(harness.capacityRequests.length, 1);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.deepEqual(
    harness.capacity.dataCenterIds,
    [...productionPlan.endpoint.dataCenterIds].sort(),
  );
  assert.deepEqual(harness.capacity.gpuTypeIds, productionPlan.endpoint.gpuTypeIds);
});

test("production capacity preparation drains an idle ready worker before capacity mutation", async () => {
  const harness = productionPreparationHarness({
    getHealth({ attempt }) {
      return attempt === 1
        ? productionHealth({
            workers: { idle: 1, initializing: 0, ready: 1, running: 0 },
          })
        : productionHealth();
    },
  });
  const result = await prepareRunpodProductionCapacity(harness.input);

  assert.equal(result.changed, true);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.equal(harness.capacityRequests.length, 1);
});

test("production capacity preparation waits for an initializing worker after drain", async () => {
  const harness = productionPreparationHarness({
    getHealth({ attempt }) {
      if (attempt === 1) {
        return productionHealth({
          workers: { idle: 1, initializing: 0, ready: 1, running: 0 },
        });
      }
      return attempt === 2
        ? productionHealth({
            workers: { idle: 0, initializing: 1, ready: 0, running: 0 },
          })
        : productionHealth();
    },
  });
  const result = await prepareRunpodProductionCapacity(harness.input);

  assert.equal(result.changed, true);
  assert.deepEqual(harness.sleepDelays, [1_000]);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.equal(harness.capacityRequests.length, 1);
});

test("production capacity preparation accepts provider-retained terminal worker history", async () => {
  const harness = productionPreparationHarness({
    workers: [{ desiredStatus: "EXITED" }],
  });
  const result = await prepareRunpodProductionCapacity(harness.input);

  assert.equal(result.changed, true);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.equal(harness.capacityRequests.length, 1);
});

test("production capacity preparation verifies drained health before capacity mutation", async () => {
  const harness = productionPreparationHarness({
    getHealth({ attempt }) {
      return attempt === 1
        ? productionHealth()
        : productionHealth({
            workers: { idle: 1, initializing: 0, ready: 1, running: 0 },
          });
    },
  });
  await assert.rejects(prepareRunpodProductionCapacity(harness.input), /active jobs or workers/u);

  assert.equal(harness.capacityRequests.length, 0);
  assert.deepEqual(harness.sleepDelays, [1_000, 2_000, 4_000, 8_000, 15_000]);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
});

test("production capacity preparation rejects a running worker before drain", async () => {
  const harness = productionPreparationHarness({
    health: productionHealth({
      workers: { idle: 0, initializing: 0, ready: 0, running: 1 },
    }),
  });
  await assert.rejects(prepareRunpodProductionCapacity(harness.input), /active jobs or workers/u);

  assert.equal(harness.capacityRequests.length, 0);
  assert.deepEqual(harness.workerMaximums, []);
});

test("production capacity preparation restores workers after capacity rollback", async () => {
  const previousCapacity = productionCapacity();
  const harness = productionPreparationHarness({
    applyCapacity({ capacity, index }) {
      return index === 2 ? previousCapacity : capacity;
    },
    initialCapacity: previousCapacity,
  });
  await assert.rejects(
    prepareRunpodProductionCapacity(harness.input),
    /GPU update did not produce/u,
  );

  assert.equal(harness.capacityRequests.length, 1);
  assert.equal(harness.dataCenterRequests.length, 2);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.deepEqual(harness.capacity, previousCapacity);
});

test("production capacity preparation rejects queued jobs before mutation", async () => {
  const harness = productionPreparationHarness({
    health: productionHealth({ jobs: { inProgress: 0, inQueue: 1 } }),
  });
  await assert.rejects(prepareRunpodProductionCapacity(harness.input), /active jobs or workers/u);
  assert.equal(harness.capacityRequests.length, 0);
  assert.deepEqual(harness.workerMaximums, []);
});

test("production capacity preparation rolls back when a job arrives while drained", async () => {
  const previousCapacity = productionCapacity();
  const harness = productionPreparationHarness({
    getHealth({ attempt }) {
      return attempt < 3
        ? productionHealth()
        : productionHealth({ jobs: { inProgress: 0, inQueue: 1 } });
    },
    initialCapacity: previousCapacity,
  });
  await assert.rejects(prepareRunpodProductionCapacity(harness.input), /active jobs or workers/u);

  assert.equal(harness.capacityRequests.length, 2);
  assert.deepEqual(harness.workerMaximums, [0, 1]);
  assert.deepEqual(harness.capacity, previousCapacity);
});

test("production capacity preparation stays drained when capacity rollback fails", async () => {
  const harness = productionPreparationHarness({
    applyCapacity({ capacity, index, request }) {
      return index === 1
        ? {
            ...capacity,
            dataCenterIds: request.dataCenterIds,
            gpuTypeIds: ["NVIDIA L4"],
          }
        : capacity;
    },
  });
  await assert.rejects(
    prepareRunpodProductionCapacity(harness.input),
    /capacity update and rollback both failed/u,
  );

  assert.equal(harness.capacityRequests.length, 2);
  assert.deepEqual(harness.workerMaximums, [0]);
  assert.equal(harness.workersMax, 0);
});

test("preflight rejects a stale worker when the candidate template is already attached", async () => {
  await assert.rejects(
    verifyRunpodPromotionPreflight({
      endpointId: "endpoint_staging",
      environment: "staging",
      plan,
      runCli(arguments_) {
        if (arguments_[0] === "user") return { id: "user" };
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpoint("template_new", [
            {
              desiredStatus: "EXITED",
              imageName: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"a".repeat(64)}`,
              templateId: "template_old",
            },
          ]);
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /different template or image/u,
  );
});

test("preflight remains idle-only when the candidate worker is running", async () => {
  await assert.rejects(
    verifyRunpodPromotionPreflight({
      endpointId: "endpoint_staging",
      environment: "staging",
      plan,
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return {
            ...endpoint("template_new", [
              {
                desiredStatus: "RUNNING",
                imageName: plan.template.image,
                templateId: "template_new",
              },
            ]),
            workersMin: 1,
          };
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /active or unrecognized workers/u,
  );
});

test("post-lifecycle verification requires a candidate worker record", async () => {
  const runVerification = (workers, workersMin = 0) =>
    verifyRunpodCandidateWorkerEvidence({
      endpointId: "endpoint_staging",
      environment: "staging",
      plan,
      runCli(arguments_) {
        if (arguments_[0] === "user") return { id: "user" };
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return {
            ...endpoint("template_new", workers),
            workersMin,
          };
        }
        throw new Error("Unexpected fake CLI call");
      },
    });

  await assert.rejects(runVerification([]), /worker evidence is missing/u);
  const terminalResult = await runVerification([
    {
      desiredStatus: "EXITED",
      imageName: plan.template.image,
      templateId: "template_new",
    },
  ]);
  assert.equal(terminalResult.templateId, "template_new");
  const activeResult = await runVerification(
    [
      {
        desiredStatus: "RUNNING",
        imageName: plan.template.image,
        templateId: "template_new",
      },
    ],
    1,
  );
  assert.equal(activeResult.templateId, "template_new");
});

test("post-lifecycle verification is restricted to staging before provider access", async () => {
  let providerAccessed = false;
  await assert.rejects(
    verifyRunpodCandidateWorkerEvidenceWithInputs({
      endpointId: "endpoint_production",
      environment: "production",
      listTemplates() {
        providerAccessed = true;
        return [];
      },
      plan,
      runCli() {
        providerAccessed = true;
        return {};
      },
    }),
    /restricted to staging/u,
  );
  assert.equal(providerAccessed, false);
});

test("post-lifecycle verification rejects capacity that does not match the candidate", async () => {
  await assert.rejects(
    verifyRunpodCandidateWorkerEvidence({
      endpointId: "endpoint_staging",
      environment: "staging",
      getEndpoint() {
        return Promise.resolve({
          compliance: plan.endpoint.compliance,
          dataCenterIds: plan.endpoint.dataCenterIds,
          gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
          id: "endpoint_staging",
        });
      },
      plan,
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpoint("template_new", [
            {
              desiredStatus: "EXITED",
              imageName: plan.template.image,
              templateId: "template_new",
            },
          ]);
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /capacity does not match/u,
  );
});

test("post-lifecycle verification rejects mismatched or multiple active workers", async () => {
  const verifyWorkers = (workers) =>
    verifyRunpodCandidateWorkerEvidence({
      endpointId: "endpoint_staging",
      environment: "staging",
      plan,
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return {
            ...endpoint("template_new", workers),
            workersMin: 1,
          };
        }
        throw new Error("Unexpected fake CLI call");
      },
    });

  await assert.rejects(
    verifyWorkers([
      {
        desiredStatus: "RUNNING",
        imageName: plan.template.image,
        templateId: "template_other",
      },
    ]),
    /does not match the release candidate/u,
  );
  await assert.rejects(
    verifyWorkers([
      {
        desiredStatus: "INITIALIZING",
        imageName: plan.template.image,
        templateId: "template_new",
      },
    ]),
    /does not match the release candidate/u,
  );
  await assert.rejects(
    verifyWorkers([
      {
        desiredStatus: "RUNNING",
        imageName: plan.template.image,
        templateId: "template_new",
      },
      {
        desiredStatus: "RUNNING",
        imageName: plan.template.image,
        templateId: "template_new",
      },
    ]),
    /multiple active workers/u,
  );
});

test("preflight classifies known provider-added ports without mutating", async () => {
  const calls = [];
  const result = await verifyRunpodPromotionPreflight({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      calls.push(arguments_);
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template" && arguments_[1] === "get") {
        return { ...template("template_new"), ports: ["8888/http", "22/tcp"] };
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_old");
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.candidateTemplatePortsRequireNormalization, true);
  assert.equal(
    calls.some((arguments_) => arguments_.includes("update")),
    false,
  );
});

test("preflight rejects a default-port candidate that is already attached", async () => {
  await assert.rejects(
    async () =>
      verifyRunpodPromotionPreflight({
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template" && arguments_[1] === "get") {
            return { ...template("template_new"), ports: ["8888/http", "22/tcp"] };
          }
          if (arguments_[0] === "serverless" && arguments_[1] === "get") {
            return endpoint("template_new");
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /already attached/u,
  );
});

test("uses the injected REST template list without invoking the CLI list command", async () => {
  const cliCalls = [];
  const result = await verifyRunpodPromotionPreflight({
    endpointId: "endpoint_staging",
    environment: "staging",
    async listTemplates() {
      return [];
    },
    plan,
    runCli(arguments_) {
      cliCalls.push(arguments_);
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_old");
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.candidateTemplateExists, false);
  assert.equal(
    cliCalls.some((arguments_) => arguments_[0] === "template" && arguments_[1] === "list"),
    false,
  );
});

test("normalizes only known default ports and verifies read-back before promotion", async () => {
  let currentTemplateId = "template_old";
  let candidatePorts = ["8888/http", "22/tcp"];
  let clearCalls = 0;
  const result = await promoteRunpodCandidate({
    async clearTemplatePorts(templateId) {
      assert.equal(templateId, "template_new");
      clearCalls += 1;
      candidatePorts = [];
    },
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") return [];
      if (arguments_[0] === "template" && arguments_[1] === "create") {
        return { ...template("template_new"), ports: candidatePorts };
      }
      if (arguments_[0] === "template" && arguments_[1] === "get") {
        return { ...template("template_new"), ports: candidatePorts };
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint(currentTemplateId);
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "update") {
        currentTemplateId = arguments_[4];
        return endpoint(currentTemplateId);
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(clearCalls, 1);
  assert.equal(result.changed, true);
  assert.equal(currentTemplateId, "template_new");
});

test("accepts an unknown port-update outcome only after exact read-back", async () => {
  let currentTemplateId = "template_old";
  let candidatePorts = ["22/tcp", "8888/http"];
  let clearCalls = 0;
  const result = await promoteRunpodCandidate({
    async clearTemplatePorts() {
      clearCalls += 1;
      candidatePorts = [];
      throw new Error("simulated response loss");
    },
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template" && arguments_[1] === "get") {
        return { ...template("template_new"), ports: candidatePorts };
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint(currentTemplateId);
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "update") {
        currentTemplateId = arguments_[4];
        return endpoint(currentTemplateId);
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(clearCalls, 1);
  assert.equal(result.changed, true);
});

test("stops before endpoint mutation when port normalization read-back still drifts", async () => {
  let endpointUpdates = 0;
  await assert.rejects(
    async () =>
      promoteRunpodCandidate({
        async clearTemplatePorts() {
          throw new Error("simulated unknown outcome");
        },
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template" && arguments_[1] === "get") {
            return { ...template("template_new"), ports: ["8888/http", "22/tcp"] };
          }
          if (arguments_[0] === "serverless" && arguments_[1] === "get") {
            return endpoint("template_old");
          }
          if (arguments_[0] === "serverless" && arguments_[1] === "update") {
            endpointUpdates += 1;
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /port normalization failed/u,
  );
  assert.equal(endpointUpdates, 0);
});

test("does not normalize unrecognized port drift", async () => {
  let clearCalls = 0;
  await assert.rejects(
    async () =>
      promoteRunpodCandidate({
        async clearTemplatePorts() {
          clearCalls += 1;
        },
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template" && arguments_[1] === "get") {
            return { ...template("template_new"), ports: ["9999/http"] };
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /does not match/u,
  );
  assert.equal(clearCalls, 0);
});

test("promotes an idle endpoint to the exact immutable template", async () => {
  let currentTemplateId = "template_old";
  const calls = [];
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      calls.push(arguments_);
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template" && arguments_[1] === "get") {
        return template("template_new");
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint(currentTemplateId);
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "update") {
        currentTemplateId = arguments_[4];
        return endpoint(currentTemplateId);
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(currentTemplateId, "template_new");
  assert.ok(
    calls.some(
      (arguments_) =>
        arguments_.join(" ") === "serverless update endpoint_staging --template-id template_new",
    ),
  );
});

test("does not mutate an endpoint that already uses the candidate template", async () => {
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template") return template("template_new");
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_new");
      }
      throw new Error("Unexpected mutating CLI call");
    },
  });
  assert.equal(result.changed, false);
});

test("drains and replaces legacy single-GPU capacity even when the template is current", async () => {
  const workerMaximums = [];
  const gpuUpdates = [];
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    initialGpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    plan,
    async setEndpointGpuTypes(request) {
      gpuUpdates.push(request);
    },
    async setEndpointWorkersMax({ workersMax }) {
      workerMaximums.push(workersMax);
    },
    runCli(arguments_) {
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template") return template("template_new");
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_new");
      }
      throw new Error("Unexpected mutating CLI call");
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(workerMaximums, [0, 1]);
  assert.deepEqual(gpuUpdates, [
    {
      endpointId: "endpoint_staging",
      gpuTypeIds: plan.endpoint.gpuTypeIds,
    },
  ]);
});

test("drains provider-retained terminal worker records before promotion", async () => {
  let currentTemplateId = "template_old";
  const terminalWorkers = () => [
    {
      desiredStatus: "EXITED",
      imageName:
        currentTemplateId === "template_new"
          ? plan.template.image
          : `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"a".repeat(64)}`,
      templateId: currentTemplateId,
    },
  ];
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template") return template("template_new");
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint(currentTemplateId, terminalWorkers());
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "update") {
        currentTemplateId = arguments_[4];
        return endpoint(currentTemplateId, terminalWorkers());
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(currentTemplateId, "template_new");
});

test("drains a stale terminal worker even when the endpoint already uses the candidate", async () => {
  const workerMaximums = [];
  let staleWorkerPresent = true;
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    plan,
    async setEndpointWorkersMax({ workersMax }) {
      workerMaximums.push(workersMax);
      if (workersMax === 0) {
        staleWorkerPresent = false;
      }
    },
    runCli(arguments_) {
      if (arguments_[0] === "user") return { id: "user" };
      if (arguments_[0] === "template" && arguments_[1] === "list") {
        return [{ id: "template_new", name: plan.template.name }];
      }
      if (arguments_[0] === "template") return template("template_new");
      if (arguments_[0] === "serverless" && arguments_[1] === "get") {
        return endpoint("template_new", [
          staleWorkerPresent
            ? {
                desiredStatus: "EXITED",
                imageName: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"a".repeat(64)}`,
                templateId: "template_old",
              }
            : {
                desiredStatus: "EXITED",
                imageName: plan.template.image,
                templateId: "template_new",
              },
        ]);
      }
      throw new Error("Unexpected mutating CLI call");
    },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(workerMaximums, [0, 1]);
});

test("refuses promotion while a running worker exists", async () => {
  await assert.rejects(
    async () =>
      promoteRunpodCandidate({
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template") return template("template_new");
          if (arguments_[0] === "serverless") {
            return endpoint("template_old", [{ desiredStatus: "RUNNING" }]);
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /active or unrecognized workers/u,
  );
});

test("refuses promotion when a worker lifecycle status is missing", async () => {
  await assert.rejects(
    async () =>
      promoteRunpodCandidate({
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template") return template("template_new");
          if (arguments_[0] === "serverless") {
            return endpoint("template_old", [{}]);
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /active or unrecognized workers/u,
  );
});

test("rolls back the template switch when read-back verification fails", async () => {
  let currentTemplateId = "template_old";
  let promotedReadback = false;
  await assert.rejects(
    async () =>
      promoteRunpodCandidate({
        endpointId: "endpoint_staging",
        environment: "staging",
        plan,
        runCli(arguments_) {
          if (arguments_[0] === "user") return { id: "user" };
          if (arguments_[0] === "template" && arguments_[1] === "list") {
            return [{ id: "template_new", name: plan.template.name }];
          }
          if (arguments_[0] === "template") return template("template_new");
          if (arguments_[0] === "serverless" && arguments_[1] === "update") {
            currentTemplateId = arguments_[4];
            return endpoint(currentTemplateId);
          }
          if (arguments_[0] === "serverless" && arguments_[1] === "get") {
            if (currentTemplateId === "template_new" && !promotedReadback) {
              promotedReadback = true;
              return {
                ...endpoint(currentTemplateId),
                scalerValue: 2,
              };
            }
            return endpoint(currentTemplateId);
          }
          throw new Error("Unexpected fake CLI call");
        },
      }),
    /does not match/u,
  );
  assert.equal(currentTemplateId, "template_old");
});

test("rolls back the exact previous GPU and data-center capacity", async () => {
  let currentTemplateId = "template_old";
  let promotedReadback = false;
  const capacityUpdates = [];
  const previousCapacity = {
    dataCenterIds: ["EU-RO-1"],
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
  };
  await assert.rejects(
    promoteRunpodCandidate({
      endpointId: "endpoint_staging",
      environment: "staging",
      initialDataCenterIds: previousCapacity.dataCenterIds,
      initialGpuTypeIds: previousCapacity.gpuTypeIds,
      plan,
      async setEndpointDataCenters(request) {
        capacityUpdates.push({ kind: "data-centers", ...request });
      },
      async setEndpointGpuTypes(request) {
        capacityUpdates.push({ kind: "gpu-types", ...request });
      },
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template") return template("template_new");
        if (arguments_[0] === "serverless" && arguments_[1] === "update") {
          currentTemplateId = arguments_[4];
          return endpoint(currentTemplateId);
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          if (currentTemplateId === "template_new" && !promotedReadback) {
            promotedReadback = true;
            return { ...endpoint(currentTemplateId), scalerValue: 2 };
          }
          return endpoint(currentTemplateId);
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /does not match/u,
  );

  assert.deepEqual(capacityUpdates, [
    {
      dataCenterIds: [...plan.endpoint.dataCenterIds].sort(),
      endpointId: "endpoint_staging",
      kind: "data-centers",
    },
    {
      endpointId: "endpoint_staging",
      gpuTypeIds: plan.endpoint.gpuTypeIds,
      kind: "gpu-types",
    },
    {
      dataCenterIds: previousCapacity.dataCenterIds,
      endpointId: "endpoint_staging",
      kind: "data-centers",
    },
    {
      endpointId: "endpoint_staging",
      gpuTypeIds: previousCapacity.gpuTypeIds,
      kind: "gpu-types",
    },
  ]);
  assert.equal(currentTemplateId, "template_old");
});

test("refuses promotion before mutation when data-center rollback evidence is missing", async () => {
  let mutations = 0;
  await assert.rejects(
    promoteRunpodCandidate({
      endpointId: "endpoint_staging",
      environment: "staging",
      initialDataCenterIds: undefined,
      initialGpuTypeIds: ["NVIDIA GeForce RTX 4090"],
      plan,
      async setEndpointDataCenters() {
        mutations += 1;
      },
      async setEndpointGpuTypes() {
        mutations += 1;
      },
      async setEndpointWorkersMax() {
        mutations += 1;
      },
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template") return template("template_new");
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpoint("template_old");
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /data-center rollback evidence is missing/u,
  );
  assert.equal(mutations, 0);
});

test("refuses promotion before mutation when compliance differs from the fixed plan", async () => {
  let mutations = 0;
  await assert.rejects(
    promoteRunpodCandidate({
      endpointId: "endpoint_staging",
      environment: "staging",
      initialCompliance: ["HIPAA"],
      plan,
      async setEndpointDataCenters() {
        mutations += 1;
      },
      async setEndpointGpuTypes() {
        mutations += 1;
      },
      async setEndpointWorkersMax() {
        mutations += 1;
      },
      runCli(arguments_) {
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template") return template("template_new");
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpoint("template_old");
        }
        throw new Error("Unexpected fake CLI call");
      },
    }),
    /compliance does not match/u,
  );
  assert.equal(mutations, 0);
});
