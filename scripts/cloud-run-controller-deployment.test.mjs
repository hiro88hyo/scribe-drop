import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  controllerDeployment,
  createControllerAuthorization,
  createControllerDeploymentConfiguration,
  createControllerServiceCreateRequest,
  createControllerServiceCreateUrl,
  createControllerServicePatchUrl,
  createControllerServiceRequest,
  isAllowedControllerDisable,
  isAllowedControllerRecoveryDisable,
  isExactControllerAuthorizationRetry,
  preflightExistingControllerService,
  requireControllerServiceValidationOperation,
} from "./cloud-run-controller-deployment.mjs";

const candidate = {
  commit: "a".repeat(40),
  controllerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:${"b".repeat(64)}`,
  workerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"c".repeat(64)}`,
};
const authorization = {
  environment: "production",
  epoch: "disabled",
  maxExecutions: 0,
  maxRequestsPerMinute: 0,
  maxWorstCaseJpy: 0,
  validUntil: "1970-01-01T00:00:00.000Z",
  worstCaseJpyPerExecution: 0,
};

test("isolates the production controller configuration from staging", () => {
  assert.deepEqual(controllerDeployment("production"), {
    controllerServiceAccount: "gpu-controller-production@scribe-drop.iam.gserviceaccount.com",
    databaseId: "scribe-production-controller",
    primarySecretName: "scribe-drop-production-controller-primary",
    runtimeServiceAccount: "gpu-runtime-production@scribe-drop.iam.gserviceaccount.com",
    serviceName: "scribe-drop-production-gpu-controller",
  });
  const configuration = createControllerDeploymentConfiguration({
    authorization,
    candidate,
    environment: "production",
    orchestratorOrigin: "https://orchestrator-production.example.invalid",
    primarySecretVersion: "1",
    r2Host: "production.r2.cloudflarestorage.com",
  });
  assert.equal(configuration.manifest.environment, "production");
  assert.equal(
    configuration.manifest.runtimeServiceAccount,
    "gpu-runtime-production@scribe-drop.iam.gserviceaccount.com",
  );
  assert.equal(configuration.primaryHmacSecret.name.includes("staging"), false);
  assert.equal(configuration.manifest.orchestratorOrigin.endsWith("/"), true);
});

test("renders only mutable reviewed Cloud Run Service fields", () => {
  const plan = {
    binaryAuthorization: { useDefault: true },
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: true,
    labels: { environment: "production" },
    name: "projects/scribe-drop/locations/asia-southeast1/services/controller",
    scaling: { maxInstanceCount: 1, minInstanceCount: 0, scalingMode: "AUTOMATIC" },
    template: {
      containers: [{ image: candidate.controllerImage }],
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      labels: { environment: "production" },
      maxInstanceRequestConcurrency: 8,
      scaling: { maxInstanceCount: 1, minInstanceCount: 0 },
      serviceAccount: "controller@example.invalid",
      sessionAffinity: false,
      timeout: "60s",
    },
    traffic: [{ percent: 100, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" }],
  };
  const request = createControllerServiceRequest(plan);
  const createRequest = createControllerServiceCreateRequest(plan);
  assert.equal(Object.hasOwn(request, "buildConfig"), false);
  assert.equal(Object.hasOwn(request.template, "encryptionKey"), false);
  assert.equal(request.template.containers.length, 1);
  assert.equal(request.name, plan.name);
  assert.equal(Object.hasOwn(createRequest, "name"), false);
  const requestWithoutName = structuredClone(request);
  delete requestWithoutName.name;
  assert.deepEqual(createRequest, requestWithoutName);
});

test("uses the exact Cloud Run PATCH request with an optional validate-only guard", () => {
  const plan = {
    name: "projects/scribe-drop/locations/asia-southeast1/services/controller",
  };
  assert.equal(
    createControllerServicePatchUrl(plan),
    "https://run.googleapis.com/v2/projects/scribe-drop/locations/asia-southeast1/services/controller?allowMissing=true&forceNewRevision=true&updateMask=binaryAuthorization%2Cingress%2CinvokerIamDisabled%2Clabels%2Cscaling%2Ctemplate%2Ctraffic",
  );
  assert.equal(
    createControllerServicePatchUrl(plan, true),
    "https://run.googleapis.com/v2/projects/scribe-drop/locations/asia-southeast1/services/controller?allowMissing=true&forceNewRevision=true&updateMask=binaryAuthorization%2Cingress%2CinvokerIamDisabled%2Clabels%2Cscaling%2Ctemplate%2Ctraffic&validateOnly=true",
  );
  assert.throws(
    () => createControllerServicePatchUrl({ name: "projects/other/services/controller" }, true),
    /deployment plan name is invalid/u,
  );
});

test("uses the exact Cloud Run create request for an absent Service", () => {
  const plan = {
    name: "projects/scribe-drop/locations/asia-southeast1/services/controller",
  };
  assert.equal(
    createControllerServiceCreateUrl(plan),
    "https://run.googleapis.com/v2/projects/scribe-drop/locations/asia-southeast1/services?serviceId=controller",
  );
  assert.equal(
    createControllerServiceCreateUrl(plan, true),
    "https://run.googleapis.com/v2/projects/scribe-drop/locations/asia-southeast1/services?serviceId=controller&validateOnly=true",
  );
  assert.throws(
    () => createControllerServiceCreateUrl({ name: "projects/other/services/controller" }, true),
    /deployment plan name is invalid/u,
  );
});

test("accepts only a safe successful validate-only operation identity", () => {
  const name =
    "projects/scribe-drop/locations/asia-southeast1/operations/123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(requireControllerServiceValidationOperation({ done: false, name }), { name });
  assert.throws(
    () => requireControllerServiceValidationOperation({ error: { code: 7 }, name }),
    /validation operation is invalid/u,
  );
  assert.throws(
    () => requireControllerServiceValidationOperation({ name: "projects/other/operations/x" }),
    /validation operation is invalid/u,
  );
});

test("validates the create request without creating an absent production controller Service", async () => {
  let validationCalls = 0;
  let reads = 0;
  const serviceExists = await preflightExistingControllerService({
    readSnapshot: async () => {
      reads += 1;
      return { exists: false };
    },
    sameSnapshot: () => {
      throw new Error("missing Service snapshots must not be compared");
    },
    validate: async () => {
      throw new Error("missing Services must use create validation");
    },
    validateMissing: async () => {
      validationCalls += 1;
    },
  });
  assert.equal(serviceExists, false);
  assert.equal(reads, 2);
  assert.equal(validationCalls, 1);
});

test("requires a stable snapshot around validate-only PATCH for an existing Service", async () => {
  const stable = { exists: true, snapshot: "stable" };
  let reads = 0;
  let validations = 0;
  const serviceExists = await preflightExistingControllerService({
    readSnapshot: async () => {
      reads += 1;
      return stable;
    },
    sameSnapshot: (before, after) => before.snapshot === after.snapshot,
    validate: async () => {
      validations += 1;
    },
    validateMissing: async () => {
      throw new Error("existing Services must use update validation");
    },
  });
  assert.equal(serviceExists, true);
  assert.equal(reads, 2);
  assert.equal(validations, 1);
});

test("rejects a Service changed during validate-only preflight", async () => {
  let reads = 0;
  await assert.rejects(
    preflightExistingControllerService({
      readSnapshot: async () => {
        reads += 1;
        return { exists: true, snapshot: reads === 1 ? "before" : "after" };
      },
      sameSnapshot: (before, after) => before.snapshot === after.snapshot,
      validate: async () => undefined,
      validateMissing: async () => undefined,
    }),
    /Cloud Run Service changed during validate-only preflight/u,
  );
});

test("rejects an unknown deployment environment", () => {
  assert.throws(() => controllerDeployment("local"), /environment is invalid/u);
});

test("fixes smoke authorization to exact one execution and 250 JPY", () => {
  assert.deepEqual(
    createControllerAuthorization({
      environment: "production",
      epoch: `phase16-smoke-${"a".repeat(40)}-123`,
      mode: "smoke",
      now: new Date("2026-08-15T00:00:00.000Z"),
      validUntil: "2026-08-15T02:00:00.000Z",
    }),
    {
      environment: "production",
      epoch: `phase16-smoke-${"a".repeat(40)}-123`,
      maxExecutions: 1,
      maxRequestsPerMinute: 60,
      maxWorstCaseJpy: 250,
      validUntil: "2026-08-15T02:00:00.000Z",
      worstCaseJpyPerExecution: 250,
    },
  );
});

test("requires an exact bounded operational budget", () => {
  const base = {
    environment: "production",
    epoch: `phase16-operational-${"a".repeat(40)}-123`,
    mode: "operational",
    now: new Date("2026-08-15T00:00:00.000Z"),
    validUntil: "2026-08-15T23:00:00.000Z",
  };
  assert.equal(
    createControllerAuthorization({ ...base, maxExecutions: 5, maxWorstCaseJpy: 1_250 })
      .maxExecutions,
    5,
  );
  assert.throws(
    () => createControllerAuthorization({ ...base, maxExecutions: 5, maxWorstCaseJpy: 1_249 }),
    /budget is invalid/u,
  );
  assert.throws(
    () => createControllerAuthorization({ ...base, maxExecutions: 21, maxWorstCaseJpy: 5_250 }),
    /budget is invalid/u,
  );
});

test("accepts only an unconsumed exact finite authorization retry", () => {
  const selected = createControllerAuthorization({
    environment: "production",
    epoch: `phase16-operational-${"a".repeat(40)}-123`,
    maxExecutions: 5,
    maxWorstCaseJpy: 1_250,
    mode: "operational",
    now: new Date("2026-08-15T00:00:00.000Z"),
    validUntil: "2026-08-15T23:00:00.000Z",
  });
  const observed = {
    ...selected,
    activeExecutions: 0,
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
  };
  assert.equal(isExactControllerAuthorizationRetry(selected, observed), true);
  assert.equal(
    isExactControllerAuthorizationRetry(selected, { ...observed, reservedExecutions: 1 }),
    false,
  );
  assert.equal(
    isExactControllerAuthorizationRetry(selected, { ...observed, maxWorstCaseJpy: 1_249 }),
    false,
  );
});

test("distinguishes an unconsumed rearm from a consumed smoke disable", () => {
  const smoke = {
    activeExecutions: 0,
    epoch: `phase16-smoke-${"a".repeat(40)}-123`,
    maxExecutions: 1,
    maxWorstCaseJpy: 250,
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
    worstCaseJpyPerExecution: 250,
  };
  assert.equal(isAllowedControllerDisable(smoke, 0), false);
  assert.equal(
    isAllowedControllerDisable(
      {
        ...smoke,
        epoch: "disabled",
        maxExecutions: 0,
        maxWorstCaseJpy: 0,
        worstCaseJpyPerExecution: 0,
      },
      0,
    ),
    true,
  );
  assert.equal(
    isAllowedControllerDisable({ ...smoke, epoch: `phase16-operational-${"a".repeat(40)}-123` }, 0),
    false,
  );
  assert.equal(isAllowedControllerDisable({ ...smoke, reservedExecutions: 1 }, 0), false);
  assert.equal(
    isAllowedControllerDisable({ ...smoke, reservedExecutions: 1, reservedWorstCaseJpy: 250 }, 1),
    true,
  );
});

test("recovery disables only the same staging smoke epoch after capacity reaches zero", () => {
  const epoch = `phase16-smoke-${"a".repeat(40)}-123`;
  const smoke = {
    activeExecutions: 0,
    environment: "staging",
    epoch,
    maxExecutions: 1,
    maxWorstCaseJpy: 250,
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
    worstCaseJpyPerExecution: 250,
  };
  assert.equal(isAllowedControllerRecoveryDisable(smoke, epoch), true);
  assert.equal(
    isAllowedControllerRecoveryDisable(
      { ...smoke, reservedExecutions: 1, reservedWorstCaseJpy: 250 },
      epoch,
    ),
    true,
  );
  assert.equal(isAllowedControllerRecoveryDisable({ ...smoke, activeExecutions: 1 }, epoch), false);
  assert.equal(
    isAllowedControllerRecoveryDisable(smoke, `phase16-smoke-${"b".repeat(40)}-123`),
    false,
  );
  assert.equal(
    isAllowedControllerRecoveryDisable({ ...smoke, environment: "production" }, epoch),
    false,
  );
  assert.equal(
    isAllowedControllerRecoveryDisable(
      {
        ...smoke,
        epoch: "disabled",
        maxExecutions: 0,
        maxWorstCaseJpy: 0,
        worstCaseJpyPerExecution: 0,
      },
      epoch,
    ),
    true,
  );
});

test("production recovery accepts only the exact unconsumed failed-cutover smoke epoch", () => {
  const epoch = `phase16-smoke-${"a".repeat(40)}-123`;
  const smoke = {
    activeExecutions: 0,
    environment: "production",
    epoch,
    maxExecutions: 1,
    maxWorstCaseJpy: 250,
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
    worstCaseJpyPerExecution: 250,
  };
  assert.equal(isAllowedControllerRecoveryDisable(smoke, epoch, "production"), true);
  assert.equal(
    isAllowedControllerRecoveryDisable(
      { ...smoke, reservedExecutions: 1, reservedWorstCaseJpy: 250 },
      epoch,
      "production",
    ),
    false,
  );
  assert.equal(
    isAllowedControllerRecoveryDisable({ ...smoke, activeExecutions: 1 }, epoch, "production"),
    false,
  );
  assert.equal(
    isAllowedControllerRecoveryDisable(
      { ...smoke, epoch: `phase16-operational-${"a".repeat(40)}-123` },
      epoch,
      "production",
    ),
    false,
  );
  assert.equal(isAllowedControllerRecoveryDisable(smoke, epoch, "staging"), false);
});

test("passes the selected environment through every manager recovery guard", () => {
  const manager = readFileSync(
    new URL("./manage-cloud-run-controller-deployment.mjs", import.meta.url),
    "utf8",
  );
  const calls = manager.match(/isAllowedControllerRecoveryDisable\s*\(/gu) ?? [];
  const environmentBoundCalls =
    manager.match(
      /isAllowedControllerRecoveryDisable\(\s*observedAuthorization\(current\.body\),\s*(?:expectedEpoch|recoveryEpoch),\s*selectedEnvironment,\s*\)/gu,
    ) ?? [];
  assert.equal(calls.length, 2);
  assert.equal(environmentBoundCalls.length, 2);
});
