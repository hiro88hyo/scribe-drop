import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyProductionAuthorizationRenewal,
  createPreviousProductionAuthorization,
  createProductionAuthorizationRenewal,
  firestoreAuthorizationPatch,
  parseProductionAuthorizationDocument,
  parseProductionControllerService,
  serviceAuthorizationEnvironment,
} from "./production-authorization-renewal.mjs";

const now = new Date("2026-09-12T04:30:00.000Z");
const previous = {
  environment: "production",
  epoch: `phase16-operational-${"a".repeat(40)}-123`,
  maxExecutions: 5,
  maxRequestsPerMinute: 60,
  maxWorstCaseJpy: 1_250,
  validUntil: "2026-09-11T04:30:00.000Z",
  worstCaseJpyPerExecution: 250,
};
const desired = createProductionAuthorizationRenewal({
  maxExecutions: "5",
  maxWorstCaseJpy: "1250",
  now,
  previousEpoch: previous.epoch,
  runId: "456",
  validUntil: "2026-09-13T04:00:00.000Z",
});

function env(authorization) {
  return [
    { name: "APP_ENV", value: "production" },
    ...Object.entries(serviceAuthorizationEnvironment(authorization)).map(([name, value]) => ({
      name,
      value,
    })),
    { name: "SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY", valueFrom: { secretKeyRef: {} } },
  ];
}

function service(authorization = previous) {
  return {
    metadata: {
      labels: {
        "cloud.googleapis.com/location": "asia-southeast1",
        "scribe-drop-component": "gpu-controller",
        "scribe-drop-environment": "production",
        "scribe-drop-policy": "cloud-run-jobs-l4-v1",
      },
      name: "scribe-drop-production-gpu-controller",
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              env: env(authorization),
              image: `asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:${"b".repeat(64)}`,
            },
          ],
          serviceAccountName: "gpu-controller-production@scribe-drop.iam.gserviceaccount.com",
        },
      },
    },
    status: { conditions: [{ status: "True", type: "Ready" }] },
  };
}

function document(authorization = previous, overrides = {}) {
  const integerValue = (value) => ({ integerValue: String(value) });
  const stringValue = (value) => ({ stringValue: value });
  return {
    fields: {
      activeExecutionHandle:
        (overrides.activeExecutions ?? 0) === 0
          ? { nullValue: null }
          : { stringValue: "not-exposed" },
      activeExecutions: integerValue(overrides.activeExecutions ?? 0),
      environment: stringValue(authorization.environment),
      epoch: stringValue(authorization.epoch),
      maxExecutions: integerValue(authorization.maxExecutions),
      maxRequestsPerMinute: integerValue(authorization.maxRequestsPerMinute),
      maxWorstCaseJpy: integerValue(authorization.maxWorstCaseJpy),
      policyId: stringValue("cloud_run_jobs_l4_v1"),
      recentAcceptedAt: { arrayValue: { values: [] } },
      reservedExecutions: integerValue(overrides.reservedExecutions ?? 0),
      reservedWorstCaseJpy: integerValue(
        (overrides.reservedExecutions ?? 0) * authorization.worstCaseJpyPerExecution,
      ),
      schemaVersion: integerValue(1),
      updatedAt: stringValue("2026-09-12T04:00:00.000Z"),
      validUntil: stringValue(authorization.validUntil),
      worstCaseJpyPerExecution: integerValue(authorization.worstCaseJpyPerExecution),
    },
    updateTime: "2026-09-12T04:00:00.000Z",
  };
}

test("creates a bounded renewal tied to the existing candidate and new run", () => {
  assert.deepEqual(desired, {
    environment: "production",
    epoch: `phase16-operational-${"a".repeat(40)}-456`,
    maxExecutions: 5,
    maxRequestsPerMinute: 60,
    maxWorstCaseJpy: 1_250,
    validUntil: "2026-09-13T04:00:00.000Z",
    worstCaseJpyPerExecution: 250,
  });
});

test("parses the exact expired authorization without widening its budget", () => {
  assert.deepEqual(
    createPreviousProductionAuthorization({
      epoch: previous.epoch,
      maxExecutions: "5",
      maxWorstCaseJpy: "1250",
      now,
      validUntil: previous.validUntil,
    }),
    previous,
  );
  assert.throws(() =>
    createPreviousProductionAuthorization({
      epoch: previous.epoch,
      maxExecutions: "5",
      now,
      validUntil: "2026-09-13T04:00:00.000Z",
    }),
  );
});

test("rejects an excessive lifetime, budget, and reused epoch", () => {
  assert.throws(() =>
    createProductionAuthorizationRenewal({
      maxExecutions: "5",
      maxWorstCaseJpy: "1250",
      now,
      previousEpoch: previous.epoch,
      runId: "456",
      validUntil: "2026-10-12T04:00:00.000Z",
    }),
  );
  assert.throws(() =>
    createProductionAuthorizationRenewal({
      maxExecutions: "21",
      maxWorstCaseJpy: "5250",
      now,
      previousEpoch: previous.epoch,
      runId: "456",
      validUntil: "2026-09-13T04:00:00.000Z",
    }),
  );
  assert.throws(() =>
    createProductionAuthorizationRenewal({
      maxExecutions: "5",
      maxWorstCaseJpy: "1250",
      now,
      previousEpoch: previous.epoch,
      runId: "123",
      validUntil: "2026-09-13T04:00:00.000Z",
    }),
  );
  assert.throws(() =>
    createProductionAuthorizationRenewal({
      maxExecutions: "5",
      maxWorstCaseJpy: "1000",
      now,
      previousEpoch: previous.epoch,
      runId: "456",
      validUntil: "2026-09-13T04:00:00.000Z",
    }),
  );
});

test("parses the exact production service and Firestore authorization", () => {
  assert.deepEqual(parseProductionControllerService(service()).authorization, previous);
  assert.deepEqual(parseProductionAuthorizationDocument(document()).authorization, previous);
  const changed = service();
  changed.metadata.labels["scribe-drop-environment"] = "staging";
  assert.throws(() => parseProductionControllerService(changed));
});

test("accepts every two-mutation recovery prefix", () => {
  const prefixes = [
    [previous, previous, "expired"],
    [desired, previous, "service-updated"],
    [previous, desired, "firestore-updated"],
    [desired, desired, "active"],
  ];
  for (const [serviceAuthorization, documentAuthorization, stage] of prefixes) {
    assert.equal(
      classifyProductionAuthorizationRenewal({
        desired,
        document: parseProductionAuthorizationDocument(document(documentAuthorization)),
        now,
        previous,
        service: parseProductionControllerService(service(serviceAuthorization)),
      }),
      stage,
    );
  }
});

test("accepts bounded consumption after activation but rejects active expired state", () => {
  assert.equal(
    classifyProductionAuthorizationRenewal({
      desired,
      document: parseProductionAuthorizationDocument(
        document(desired, { activeExecutions: 1, reservedExecutions: 1 }),
      ),
      now,
      previous,
      service: parseProductionControllerService(service(desired)),
    }),
    "active",
  );
  assert.throws(() =>
    classifyProductionAuthorizationRenewal({
      desired,
      document: parseProductionAuthorizationDocument(
        document(previous, { activeExecutions: 1, reservedExecutions: 1 }),
      ),
      now,
      previous,
      service: parseProductionControllerService(service(previous)),
    }),
  );
});

test("builds an exact service env set and conditional Firestore reset patch", () => {
  assert.equal(Object.keys(serviceAuthorizationEnvironment(desired)).length, 6);
  const patch = firestoreAuthorizationPatch(
    desired,
    "2026-09-12T04:00:00.000Z",
    "2026-09-12T04:30:00.000Z",
  );
  assert.equal(patch.updateTime, "2026-09-12T04:00:00.000Z");
  assert.equal(patch.body.fields.reservedExecutions.integerValue, "0");
  assert.equal(patch.body.fields.updatedAt.stringValue, "2026-09-12T04:30:00.000Z");
  assert.deepEqual(patch.body.fields.recentAcceptedAt.arrayValue.values, []);
  assert.deepEqual(Object.keys(patch.body.fields).sort(), [
    "epoch",
    "maxExecutions",
    "maxRequestsPerMinute",
    "maxWorstCaseJpy",
    "recentAcceptedAt",
    "reservedExecutions",
    "reservedWorstCaseJpy",
    "updatedAt",
    "validUntil",
    "worstCaseJpyPerExecution",
  ]);
});
