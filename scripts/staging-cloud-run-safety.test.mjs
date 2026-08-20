import assert from "node:assert/strict";
import test from "node:test";

import { isStagingRecoveryReady, verifyStagingCloudRunSafe } from "./staging-cloud-run-safety.mjs";

function integerValue(value) {
  return { integerValue: String(value) };
}

function document(overrides = {}) {
  const values = {
    activeExecutions: 0,
    environment: "staging",
    epoch: "disabled",
    maxExecutions: 0,
    maxWorstCaseJpy: 0,
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
    worstCaseJpyPerExecution: 0,
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

test("accepts only disabled authorization with Cloud Run resource zero", () => {
  assert.deepEqual(
    verifyStagingCloudRunSafe({ environmentDocument: document(), executions: [], jobs: [] }),
    {
      activeExecutions: 0,
      authorization: "disabled",
      executionCount: 0,
      jobCount: 0,
      reservedExecutions: 0,
    },
  );
  assert.throws(
    () =>
      verifyStagingCloudRunSafe({ environmentDocument: document(), executions: [{}], jobs: [] }),
    /disabled zero state/u,
  );
});

test("waits for the same smoke epoch and rejects unrelated authorization", () => {
  const epoch = `phase16-smoke-${"a".repeat(40)}-123`;
  const smoke = {
    epoch,
    maxExecutions: 1,
    maxWorstCaseJpy: 250,
    reservedExecutions: 1,
    reservedWorstCaseJpy: 250,
    worstCaseJpyPerExecution: 250,
  };
  assert.equal(isStagingRecoveryReady(document(smoke), epoch), true);
  assert.equal(isStagingRecoveryReady(document({ ...smoke, activeExecutions: 1 }), epoch), false);
  assert.equal(isStagingRecoveryReady(undefined, epoch), true);
  assert.throws(
    () => isStagingRecoveryReady(document(smoke), `phase16-smoke-${"b".repeat(40)}-123`),
    /does not belong/u,
  );
});
