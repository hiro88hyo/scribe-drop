import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRunpodEndpointArguments,
  createRunpodProductionPlan,
  createRunpodStagingPlan,
  createRunpodTemplateArguments,
  validateCreatedRunpodEndpoint,
  validateCreatedRunpodTemplate,
  validateRunpodEndpointCapacity,
  validateRunpodGpuInventory,
  validateRunpodGpuInventoryConfiguration,
  validateRunpodGpuInventoryPolicyConfiguration,
  validateRunpodProductionPlan,
  validateRunpodStagingPlan,
} from "./runpod-environment-config.mjs";

const validInput = {
  accountId: "a".repeat(32),
  gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090",
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
  assert.deepEqual(plan.endpoint.gpuTypeIds, [
    "NVIDIA GeForce RTX 5090",
    "NVIDIA GeForce RTX 4090",
  ]);
  assert.deepEqual(plan.endpoint.dataCenterIds, ["EUR-IS-1", "EU-RO-1"]);
  assert.deepEqual(plan.endpoint.compliance, []);
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
  assert.deepEqual(endpointArguments, [
    "serverless",
    "create",
    "--name",
    "scribe-drop-staging",
    "--template-id",
    "template_staging",
    "--compute-type",
    "GPU",
    "--gpu-id",
    "NVIDIA GeForce RTX 5090",
    "--gpu-count",
    "1",
    "--data-center-ids",
    "EUR-IS-1,EU-RO-1",
    "--workers-min",
    "0",
    "--workers-max",
    "1",
    "--min-cuda-version",
    "12.8",
    "--scale-by",
    "requests",
    "--scale-threshold",
    "1",
    "--idle-timeout",
    "5",
    "--flash-boot=false",
    "--execution-timeout",
    "21600",
  ]);
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
  assert.deepEqual(
    validateRunpodEndpointCapacity(
      {
        compliance: plan.endpoint.compliance,
        dataCenterIds: plan.endpoint.dataCenterIds,
        id: endpointId,
        gpuTypeIds: plan.endpoint.gpuTypeIds,
      },
      plan,
    ),
    {
      compliance: plan.endpoint.compliance,
      dataCenterIds: plan.endpoint.dataCenterIds,
      gpuTypeIds: plan.endpoint.gpuTypeIds,
    },
  );
});

test("accepts runpodctl read responses that omit create-only placement fields", () => {
  const plan = createRunpodStagingPlan(validInput);

  assert.equal(
    validateCreatedRunpodEndpoint(
      {
        id: "endpoint_staging",
        name: "scribe-drop-staging",
        templateId: "template_staging",
        gpuCount: 1,
        workersMax: 1,
        idleTimeout: 5,
        executionTimeoutMs: 21_600_000,
        minCudaVersion: "12.8",
        scalerType: "REQUEST_COUNT",
        scalerValue: 1,
        flashboot: false,
      },
      plan,
      "template_staging",
    ),
    "endpoint_staging",
  );
});

test("requires official REST read-back for exact endpoint capacity", () => {
  const plan = createRunpodStagingPlan(validInput);
  const endpoint = {
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
    flashBootType: "OFF",
  };

  assert.throws(
    () =>
      validateCreatedRunpodEndpoint({ ...endpoint, computeType: "CPU" }, plan, "template_staging"),
    /does not match/u,
  );
  assert.throws(
    () =>
      validateRunpodEndpointCapacity(
        {
          compliance: plan.endpoint.compliance,
          dataCenterIds: plan.endpoint.dataCenterIds,
          id: "endpoint_staging",
          gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
        },
        plan,
      ),
    /capacity does not match/u,
  );
  assert.equal(
    validateCreatedRunpodEndpoint(
      {
        ...endpoint,
        gpuTypeIds: ["NVIDIA A40"],
        locations: "US-TX-1",
      },
      plan,
      "template_staging",
    ),
    "endpoint_staging",
  );
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

test("rejects ambiguous registry and GPU configuration", () => {
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
        gpuTypeIds: "NVIDIA L4,NVIDIA RTX A5000,NVIDIA GeForce RTX 4090,NVIDIA GeForce RTX 5090",
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS/u,
  );
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        gpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 5090",
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS/u,
  );
  assert.throws(
    () =>
      createRunpodStagingPlan({
        ...validInput,
        gpuTypeIds: "NVIDIA RTX PRO 4500 Blackwell,NVIDIA L4",
      }),
    /SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS/u,
  );
});

test("requires both fixed GPU fallbacks to have Secure capacity available", () => {
  const plan = createRunpodStagingPlan(validInput);
  const inventory = plan.endpoint.gpuTypeIds.map((gpuId, index) => ({
    available: true,
    communityCloud: true,
    gpuId,
    secureCloud: true,
    stockStatus: index === 0 ? "Low" : "High",
  }));

  assert.deepEqual(validateRunpodGpuInventory(inventory, plan), {
    availableCount: 2,
    configuredCount: 2,
  });
  assert.deepEqual(
    validateRunpodGpuInventoryConfiguration(inventory, validInput.gpuTypeIds, "staging"),
    {
      availableCount: 2,
      configuredCount: 2,
    },
  );
  assert.deepEqual(
    validateRunpodGpuInventoryPolicyConfiguration(
      inventory.map((entry) => ({ ...entry, available: false })),
      validInput.gpuTypeIds,
      "staging",
    ),
    {
      configuredCount: 2,
    },
  );
  assert.throws(
    () =>
      validateRunpodGpuInventory(
        inventory.map((entry, index) => (index === 1 ? { ...entry, secureCloud: false } : entry)),
        plan,
      ),
    /does not offer Secure Cloud/u,
  );
  assert.throws(
    () =>
      validateRunpodGpuInventory(
        inventory.map((entry, index) => (index > 0 ? { ...entry, available: false } : entry)),
        plan,
      ),
    /fallback capacity is not release-ready/u,
  );
});

test("creates and validates an isolated production plan", () => {
  const productionInput = {
    ...validInput,
    orchestratorOrigin: "https://orchestrator-production.example.invalid",
    registryAuthId: "registry_auth_production",
  };
  const plan = createRunpodProductionPlan(productionInput);

  assert.equal(plan.environment, "production");
  assert.equal(plan.template.name, `scribe-drop-worker-production-${"b".repeat(12)}`);
  assert.equal(plan.template.environment.APP_ENV, "production");
  assert.equal(plan.endpoint.name, "scribe-drop-production");
  assert.deepEqual(validateRunpodProductionPlan(plan), plan);
  assert.throws(() => validateRunpodStagingPlan(plan), /environment must be staging/u);
});

test("rejects staging markers in production RunPod inputs", () => {
  assert.throws(
    () =>
      createRunpodProductionPlan({
        ...validInput,
        registryAuthId: "registry_auth_production",
      }),
    /staging environment marker/u,
  );
  assert.throws(
    () =>
      createRunpodProductionPlan({
        ...validInput,
        orchestratorOrigin: "https://orchestrator-production.example.invalid",
      }),
    /staging environment marker/u,
  );
});
