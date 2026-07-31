import assert from "node:assert/strict";
import { test } from "node:test";

import { environmentPolicyId } from "./environment-parity.mjs";
import {
  createRunpodProductionPlan,
  createRunpodStagingPlan,
} from "./runpod-environment-config.mjs";

const image = `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`;

function runpodPlan(environment, overrides = {}) {
  const createPlan =
    environment === "staging" ? createRunpodStagingPlan : createRunpodProductionPlan;
  return createPlan({
    accountId: environment === "staging" ? "a".repeat(32) : "b".repeat(32),
    gpuTypeIds:
      overrides.gpuTypeIds ??
      "NVIDIA GeForce RTX 5090,NVIDIA RTX PRO 4500 Blackwell,NVIDIA GeForce RTX 4090",
    image,
    imageVisibility: "private",
    orchestratorOrigin: `https://orchestrator-${environment}.example.invalid`,
    registryAuthId: `registry_${environment}`,
  });
}

function input(environment, overrides = {}) {
  const webOrigin = `https://web-${environment}.example.invalid`;
  return {
    environment,
    cors: {
      rules: [
        {
          id: `scribe-drop-browser-multipart-${environment}`,
          allowed: {
            headers: ["content-type"],
            methods: ["PUT"],
            origins: [webOrigin],
          },
          exposeHeaders: ["etag"],
          maxAgeSeconds: 3600,
        },
      ],
    },
    lifecycle: {
      rules: [
        {
          id: `scribe-drop-incoming-retention-${environment}`,
          enabled: true,
          conditions: { prefix: "incoming/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 604800 } },
          abortMultipartUploadsTransition: {
            condition: { type: "Age", maxAge: 86400 },
          },
        },
        {
          id: `scribe-drop-results-retention-${environment}`,
          enabled: true,
          conditions: { prefix: "results/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 7776000 } },
        },
      ],
    },
    retention: {
      auditRetentionDays: "180",
      multipartRetentionHours: "24",
      resultRetentionDays: overrides.resultRetentionDays ?? "90",
      sourceRetentionDays: "7",
    },
    runpodPlan: runpodPlan(environment, overrides),
    webOrigin,
  };
}

test("allows only normalized environment-specific identifiers to differ", () => {
  assert.equal(environmentPolicyId(input("staging")), environmentPolicyId(input("production")));
});

test("detects operational retention drift and rejects unreviewed GPU drift", () => {
  const stagingPolicy = environmentPolicyId(input("staging"));
  assert.notEqual(
    stagingPolicy,
    environmentPolicyId(input("production", { resultRetentionDays: "91" })),
  );
  assert.throws(
    () => environmentPolicyId(input("production", { gpuTypeIds: "NVIDIA L40S,NVIDIA L4" })),
    /RUNPOD_GPU_IDS/u,
  );
});

test("rejects a CORS rule identifier from another environment", () => {
  const production = input("production");
  production.cors.rules[0].id = "scribe-drop-browser-multipart-staging";
  assert.throws(
    () => environmentPolicyId(production),
    /R2 CORS policy does not match the environment/u,
  );
});
