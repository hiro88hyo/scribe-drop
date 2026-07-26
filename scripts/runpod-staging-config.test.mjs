import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunpodEndpointArguments,
  createRunpodStagingPlan,
  createRunpodTemplateArguments,
  validateCreatedRunpodEndpoint,
  validateCreatedRunpodTemplate,
  validateRunpodStagingPlan,
} from "./runpod-staging-config.mjs";

const validInput = {
  accountId: "a".repeat(32),
  dataCenterIds: "AP-JP-1,EU-SE-1",
  gpuId: "NVIDIA L4",
  image: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "b".repeat(64),
  imageVisibility: "private",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  registryAuthId: "registry_auth_staging",
};

test("creates a fixed staging plan without persistent storage or secrets", () => {
  const plan = createRunpodStagingPlan(validInput);

  assert.equal(plan.template.name, `scribe-drop-worker-staging-${"b".repeat(12)}`);
  assert.equal(plan.template.registryAuthId, "registry_auth_staging");
  assert.equal(plan.template.containerDiskInGb, 30);
  assert.equal(plan.template.volumeInGb, 0);
  assert.deepEqual(plan.template.ports, []);
  assert.deepEqual(plan.endpoint.dataCenterIds, ["AP-JP-1", "EU-SE-1"]);
  assert.equal(plan.endpoint.workersMin, 0);
  assert.equal(plan.endpoint.workersMax, 1);
  assert.equal(plan.endpoint.gpuCount, 1);
  assert.equal(plan.endpoint.flashBoot, false);
  assert.deepEqual(plan.endpoint.networkVolumeIds, []);
  assert.equal(
    plan.template.environment.ALLOWED_SOURCE_HOSTS,
    `${"a".repeat(32)}.r2.cloudflarestorage.com`,
  );
  assert.equal(
    plan.template.environment.ALLOWED_RESULT_HOSTS,
    `${"a".repeat(32)}.r2.cloudflarestorage.com`,
  );
  assert.equal(Object.hasOwn(plan.template.environment, "RUNPOD_API_KEY"), false);
});

test("accepts an explicitly public image without registry authentication", () => {
  const plan = createRunpodStagingPlan({
    ...validInput,
    imageVisibility: "public",
    registryAuthId: undefined,
  });

  assert.equal(plan.template.registryAuthId, null);
});

test("generates minimal template and endpoint CLI arguments", () => {
  const plan = createRunpodStagingPlan(validInput);
  const templateArguments = createRunpodTemplateArguments(plan);
  const endpointArguments = createRunpodEndpointArguments(plan, "template_staging");

  assert.deepEqual(templateArguments.slice(0, 2), ["template", "create"]);
  assert.ok(templateArguments.includes("--serverless"));
  assert.ok(templateArguments.includes("--registry-auth-id"));
  assert.equal(templateArguments.includes("--volume-in-gb"), false);
  assert.equal(templateArguments.includes("--ports"), false);
  assert.deepEqual(endpointArguments.slice(0, 2), ["serverless", "create"]);
  assert.ok(endpointArguments.includes("--flash-boot=false"));
  assert.ok(endpointArguments.includes("--workers-min"));
  assert.ok(endpointArguments.includes("--workers-max"));
  assert.equal(endpointArguments.includes("--network-volume-id"), false);
  assert.equal(endpointArguments.includes("--model-reference"), false);
});

test("validates template and endpoint create responses", () => {
  const plan = createRunpodStagingPlan(validInput);
  const templateId = validateCreatedRunpodTemplate(
    {
      id: "template_staging",
      name: plan.template.name,
      imageName: plan.template.image,
      isServerless: true,
      containerDiskInGb: 30,
      containerRegistryAuthId: "registry_auth_staging",
      env: plan.template.environment,
    },
    plan,
  );
  const endpointId = validateCreatedRunpodEndpoint(
    {
      id: "endpoint_staging",
      name: "scribe-drop-staging",
      templateId,
      computeType: "GPU",
      gpuIds: "AMPERE_24",
      gpuCount: 1,
      workersMax: 1,
      locations: "AP-JP-1,EU-SE-1",
      idleTimeout: 5,
      executionTimeoutMs: 21_600_000,
      minCudaVersion: "12.8",
      scalerType: "REQUEST_COUNT",
      scalerValue: 1,
      flashBootType: "OFF",
    },
    plan,
    templateId,
  );

  assert.equal(templateId, "template_staging");
  assert.equal(endpointId, "endpoint_staging");
});

test("rejects deployment responses that weaken isolation", () => {
  const plan = createRunpodStagingPlan(validInput);
  assert.throws(
    () =>
      validateCreatedRunpodEndpoint(
        {
          id: "endpoint_staging",
          name: "scribe-drop-staging",
          templateId: "template_staging",
          computeType: "GPU",
          gpuIds: "AMPERE_24",
          gpuCount: 1,
          workersMax: 1,
          locations: "AP-JP-1,EU-SE-1",
          idleTimeout: 5,
          executionTimeoutMs: 21_600_000,
          minCudaVersion: "12.8",
          scalerType: "REQUEST_COUNT",
          scalerValue: 1,
          flashBootType: "FLASHBOOT",
          networkVolumeIds: [{ networkVolumeId: "unexpected" }],
        },
        plan,
        "template_staging",
      ),
    /does not match/u,
  );
});

test("rejects mutable images and unsafe origins", () => {
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        image: "ghcr.io/example/scribe-drop-runpod-worker:latest",
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_IMAGE/u,
  );
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        orchestratorOrigin: "http://localhost:8787",
      }),
    /SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN/u,
  );
});

test("rejects a modified generated plan", () => {
  const plan = createRunpodStagingPlan(validInput);
  assert.deepEqual(validateRunpodStagingPlan(plan), plan);
  assert.throws(
    () =>
      validateRunpodStagingPlan({
        ...plan,
        endpoint: { ...plan.endpoint, workersMax: 2 },
      }),
    /fixed policy/u,
  );
});

test("rejects ambiguous registry and placement configuration", () => {
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        registryAuthId: undefined,
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_REGISTRY_AUTH_ID/u,
  );
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        imageVisibility: "public",
      }),
    /must not use registry authentication/u,
  );
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        dataCenterIds: "AP-JP-1,AP-JP-1",
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_DATACENTER_IDS/u,
  );
});
