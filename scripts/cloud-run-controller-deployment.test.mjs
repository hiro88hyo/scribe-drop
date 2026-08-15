import assert from "node:assert/strict";
import test from "node:test";

import {
  controllerDeployment,
  createControllerAuthorization,
  createControllerDeploymentConfiguration,
  createControllerServiceRequest,
  isAllowedControllerDisable,
  isExactControllerAuthorizationRetry,
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
  const request = createControllerServiceRequest({
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
  });
  assert.equal(Object.hasOwn(request, "buildConfig"), false);
  assert.equal(Object.hasOwn(request.template, "encryptionKey"), false);
  assert.equal(request.template.containers.length, 1);
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
