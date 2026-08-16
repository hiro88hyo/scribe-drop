import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyAuthorizedAcceptanceSnapshot,
  verifyRecoveredAcceptanceSnapshot,
} from "./cloud-run-acceptance-state.mjs";

const epoch = `phase16-smoke-${"a".repeat(40)}-123`;

function integerValue(value) {
  return { integerValue: String(value) };
}

function authorization(overrides = {}) {
  const values = {
    activeExecutions: 0,
    environment: "staging",
    epoch,
    maxExecutions: 1,
    maxWorstCaseJpy: 250,
    reservedExecutions: 1,
    reservedWorstCaseJpy: 250,
    worstCaseJpyPerExecution: 250,
    ...overrides,
  };
  return {
    fields: {
      activeExecutions: integerValue(values.activeExecutions),
      environment: { stringValue: values.environment },
      epoch: { stringValue: values.epoch },
      maxExecutions: integerValue(values.maxExecutions),
      maxWorstCaseJpy: integerValue(values.maxWorstCaseJpy),
      reservedExecutions: integerValue(values.reservedExecutions),
      reservedWorstCaseJpy: integerValue(values.reservedWorstCaseJpy),
      worstCaseJpyPerExecution: integerValue(values.worstCaseJpyPerExecution),
    },
  };
}

function executionDocuments(state = "CLEANED") {
  return {
    documents: [
      {
        fields: {
          record: {
            mapValue: {
              fields: {
                cleanupIntent: { booleanValue: true },
                createdAt: { stringValue: "2026-08-16T02:18:00.000Z" },
                environment: { stringValue: "staging" },
                execution: { nullValue: null },
                job: { nullValue: null },
                reservedWorstCaseJpy: integerValue(250),
                state: { stringValue: state },
                updatedAt: { stringValue: "2026-08-16T02:22:00.000Z" },
              },
            },
          },
        },
      },
    ],
  };
}

test("treats a still-active exact-one acceptance as pending rather than failed", () => {
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(
      {
        environmentDocument: authorization({ activeExecutions: 1 }),
        executionDocuments: executionDocuments("CLEANUP_PENDING"),
        executions: [],
        jobs: [],
      },
      epoch,
    ),
    { complete: false },
  );
});

test("accepts exact-one authorized cleanup only after full convergence", () => {
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(
      {
        environmentDocument: authorization(),
        executionDocuments: executionDocuments(),
        executions: [],
        jobs: [],
      },
      epoch,
    ),
    { complete: true },
  );
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(
        {
          environmentDocument: authorization({ reservedExecutions: 0 }),
          executionDocuments: executionDocuments(),
          executions: [],
          jobs: [],
        },
        epoch,
      ),
    /did not consume exact one/u,
  );
});

test("accepts one cleaned source-run record in the recovered disabled state", () => {
  assert.deepEqual(
    verifyRecoveredAcceptanceSnapshot(
      {
        environmentDocument: authorization({
          activeExecutions: 0,
          epoch: "disabled",
          maxExecutions: 0,
          maxWorstCaseJpy: 0,
          reservedExecutions: 0,
          reservedWorstCaseJpy: 0,
          worstCaseJpyPerExecution: 0,
        }),
        executionDocuments: executionDocuments(),
        executions: [],
        jobs: [],
      },
      { created_at: "2026-08-16T02:12:00.000Z", updated_at: "2026-08-16T02:23:00.000Z" },
    ),
    {
      activeExecutions: 0,
      executionCount: 0,
      jobCount: 0,
      providerRecord: "CLEANED",
      reservedExecutions: 1,
    },
  );
});
