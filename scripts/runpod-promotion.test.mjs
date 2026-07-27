import assert from "node:assert/strict";
import { test } from "node:test";

import { promoteRunpodCandidate } from "./runpod-promotion.mjs";
import { createRunpodStagingPlan } from "./runpod-environment-config.mjs";

const plan = createRunpodStagingPlan({
  accountId: "a".repeat(32),
  dataCenterIds: "EU-RO-1",
  gpuId: "NVIDIA GeForce RTX 4090",
  image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  registryAuthId: "registry_staging",
});

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

function endpoint(templateId, workers = []) {
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
    workersMax: plan.endpoint.workersMax,
    workersMin: plan.endpoint.workersMin,
  };
}

test("promotes an idle endpoint to the exact immutable template", () => {
  let currentTemplateId = "template_old";
  const calls = [];
  const result = promoteRunpodCandidate({
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

test("does not mutate an endpoint that already uses the candidate template", () => {
  const result = promoteRunpodCandidate({
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

test("allows provider-retained terminal worker records", () => {
  let currentTemplateId = "template_old";
  const terminalWorkers = [{ desiredStatus: "EXITED" }, { desiredStatus: "TERMINATED" }];
  const result = promoteRunpodCandidate({
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
        return endpoint(currentTemplateId, terminalWorkers);
      }
      if (arguments_[0] === "serverless" && arguments_[1] === "update") {
        currentTemplateId = arguments_[4];
        return endpoint(currentTemplateId, terminalWorkers);
      }
      throw new Error("Unexpected fake CLI call");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(currentTemplateId, "template_new");
});

test("refuses promotion while a running worker exists", () => {
  assert.throws(
    () =>
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

test("refuses promotion when a worker lifecycle status is missing", () => {
  assert.throws(
    () =>
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

test("rolls back the template switch when read-back verification fails", () => {
  let currentTemplateId = "template_old";
  let promotedReadback = false;
  assert.throws(
    () =>
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
                workersMax: 2,
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
