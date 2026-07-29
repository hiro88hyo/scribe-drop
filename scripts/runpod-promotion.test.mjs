import assert from "node:assert/strict";
import { test } from "node:test";

import {
  promoteRunpodCandidate as promoteRunpodCandidateWithInputs,
  verifyRunpodPromotionPreflight as verifyRunpodPromotionPreflightWithInputs,
} from "./runpod-promotion.mjs";
import { createRunpodStagingPlan } from "./runpod-environment-config.mjs";

const plan = createRunpodStagingPlan({
  accountId: "a".repeat(32),
  gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090",
  image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  registryAuthId: "registry_staging",
});

function withTemplateList(input) {
  return {
    ...input,
    getEndpoint:
      input.getEndpoint ??
      (() =>
        Promise.resolve({
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

function promoteRunpodCandidate(input) {
  let workersMax = plan.endpoint.workersMax;
  let dataCenterIds = input.initialDataCenterIds;
  let gpuTypeIds = input.initialGpuTypeIds ?? plan.endpoint.gpuTypeIds;
  const runCli = input.runCli;
  return promoteRunpodCandidateWithInputs(
    withTemplateList({
      ...input,
      getEndpoint:
        input.getEndpoint ??
        (() =>
          Promise.resolve({
            ...(dataCenterIds === undefined ? {} : { dataCenterIds }),
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
      async setEndpointCapacity(request) {
        if (input.setEndpointCapacity !== undefined) {
          await input.setEndpointCapacity(request);
        }
        if (Object.hasOwn(request, "dataCenterIds")) {
          dataCenterIds = request.dataCenterIds;
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

test("post-lifecycle preflight requires a candidate worker record", async () => {
  const runPreflight = (workers) =>
    verifyRunpodPromotionPreflight({
      endpointId: "endpoint_staging",
      environment: "staging",
      plan,
      requireCandidateWorker: true,
      runCli(arguments_) {
        if (arguments_[0] === "user") return { id: "user" };
        if (arguments_[0] === "template" && arguments_[1] === "list") {
          return [{ id: "template_new", name: plan.template.name }];
        }
        if (arguments_[0] === "template" && arguments_[1] === "get") {
          return template("template_new");
        }
        if (arguments_[0] === "serverless" && arguments_[1] === "get") {
          return endpoint("template_new", workers);
        }
        throw new Error("Unexpected fake CLI call");
      },
    });

  await assert.rejects(runPreflight([]), /worker evidence is missing/u);
  const result = await runPreflight([
    {
      desiredStatus: "EXITED",
      imageName: plan.template.image,
      templateId: "template_new",
    },
  ]);
  assert.equal(result.candidateTemplateExists, true);
});

test("post-lifecycle preflight rejects capacity that does not match the candidate", async () => {
  await assert.rejects(
    verifyRunpodPromotionPreflight({
      endpointId: "endpoint_staging",
      environment: "staging",
      getEndpoint() {
        return Promise.resolve({
          gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
          id: "endpoint_staging",
        });
      },
      plan,
      requireCandidateWorker: true,
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
    /capacity evidence does not match/u,
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
  const capacityUpdates = [];
  const result = await promoteRunpodCandidate({
    endpointId: "endpoint_staging",
    environment: "staging",
    initialGpuTypeIds: ["NVIDIA GeForce RTX 4090"],
    plan,
    async setEndpointCapacity(request) {
      capacityUpdates.push(request);
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
  assert.deepEqual(capacityUpdates, [
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

test("rolls back capacity without inventing an omitted data-center field", async () => {
  let currentTemplateId = "template_old";
  let promotedReadback = false;
  const capacityUpdates = [];
  const previousCapacity = {
    gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
  };
  await assert.rejects(
    promoteRunpodCandidate({
      endpointId: "endpoint_staging",
      environment: "staging",
      initialGpuTypeIds: previousCapacity.gpuTypeIds,
      plan,
      async setEndpointCapacity(request) {
        capacityUpdates.push(request);
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
      endpointId: "endpoint_staging",
      gpuTypeIds: plan.endpoint.gpuTypeIds,
    },
    {
      endpointId: "endpoint_staging",
      ...previousCapacity,
    },
  ]);
  assert.equal(currentTemplateId, "template_old");
});
