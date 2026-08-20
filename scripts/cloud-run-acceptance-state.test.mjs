import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  verifyAuthorizedAcceptanceSnapshot,
  verifyRecoveredAcceptanceSnapshot,
} from "./cloud-run-acceptance-state.mjs";

const commit = "a".repeat(40);
const epoch = `phase16-smoke-${commit}-123`;
const sourceRun = {
  created_at: "2026-08-16T02:12:00Z",
  head_sha: commit,
  id: 123,
  updated_at: "2026-08-16T02:23:00Z",
};

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
    validUntil: "2026-08-16T04:12:00.000Z",
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
      validUntil: { stringValue: values.validUntil },
      worstCaseJpyPerExecution: integerValue(values.worstCaseJpyPerExecution),
    },
  };
}

function executionRecord({
  createdAt = "2026-08-16T02:18:00.000Z",
  environment = "staging",
  state = "CLEANED",
  updatedAt = "2026-08-16T02:22:00.000Z",
} = {}) {
  return {
    fields: {
      record: {
        mapValue: {
          fields: {
            cleanupIntent: { booleanValue: true },
            createdAt: { stringValue: createdAt },
            environment: { stringValue: environment },
            execution: { nullValue: null },
            job: { nullValue: null },
            reservedWorstCaseJpy: integerValue(250),
            state: { stringValue: state },
            updatedAt: { stringValue: updatedAt },
          },
        },
      },
    },
  };
}

function executionDocuments(...records) {
  return { documents: records.length === 0 ? [executionRecord()] : records };
}

function authorizedInput(overrides = {}) {
  return {
    environmentDocument: authorization(),
    executionDocuments: executionDocuments(),
    executions: [],
    jobs: [],
    ...overrides,
  };
}

test("treats a still-active exact-one acceptance as pending rather than failed", () => {
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(
      authorizedInput({
        environmentDocument: authorization({ activeExecutions: 1 }),
        executionDocuments: executionDocuments(executionRecord({ state: "CLEANUP_PENDING" })),
      }),
      epoch,
      "staging",
      sourceRun,
    ),
    { complete: false },
  );
});

test("accepts the source-run execution with cleaned historical records", () => {
  const historical = executionRecord({
    createdAt: "2026-08-15T02:18:00.000Z",
    updatedAt: "2026-08-15T02:22:00.000Z",
  });
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(
      authorizedInput({ executionDocuments: executionDocuments(historical, executionRecord()) }),
      epoch,
      "staging",
      sourceRun,
    ),
    { complete: true },
  );
});

test("rejects an unclean historical record and ambiguous source-run records", () => {
  const historicalPending = executionRecord({
    createdAt: "2026-08-15T02:18:00.000Z",
    state: "CLEANUP_PENDING",
    updatedAt: "2026-08-15T02:22:00.000Z",
  });
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(
        authorizedInput({
          executionDocuments: executionDocuments(historicalPending, executionRecord()),
        }),
        epoch,
        "staging",
        sourceRun,
      ),
    /Historical controller execution/u,
  );
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(
        authorizedInput({
          executionDocuments: executionDocuments(
            executionRecord(),
            executionRecord({
              createdAt: "2026-08-16T02:19:00.000Z",
              updatedAt: "2026-08-16T02:22:30.000Z",
            }),
          ),
        }),
        epoch,
        "staging",
        sourceRun,
      ),
    /not exact one for the source run/u,
  );
});

test("rejects pagination and a source workflow identity mismatch", () => {
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(
        authorizedInput({
          executionDocuments: { ...executionDocuments(), nextPageToken: "more" },
        }),
        epoch,
        "staging",
        sourceRun,
      ),
    /inventory is not bounded/u,
  );
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(authorizedInput(), epoch, "staging", {
        ...sourceRun,
        id: 124,
      }),
    /epoch is invalid/u,
  );
});

test("accepts exact-one authorized cleanup only after full convergence", () => {
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(authorizedInput(), epoch, "staging", sourceRun),
    { complete: true },
  );
  assert.throws(
    () =>
      verifyAuthorizedAcceptanceSnapshot(
        authorizedInput({
          environmentDocument: authorization({ reservedExecutions: 0 }),
        }),
        epoch,
        "staging",
        sourceRun,
      ),
    /did not consume exact one/u,
  );
});

test("validates production cleanup against the production controller identity", () => {
  assert.deepEqual(
    verifyAuthorizedAcceptanceSnapshot(
      authorizedInput({
        environmentDocument: authorization({ environment: "production" }),
        executionDocuments: executionDocuments(executionRecord({ environment: "production" })),
      }),
      epoch,
      "production",
      sourceRun,
    ),
    { complete: true },
  );
});

test("accepts the recovered source-run record with cleaned history", () => {
  const historical = executionRecord({
    createdAt: "2026-08-15T02:18:00.000Z",
    updatedAt: "2026-08-15T02:22:00.000Z",
  });
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
        executionDocuments: executionDocuments(historical, executionRecord()),
        executions: [],
        jobs: [],
      },
      sourceRun,
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

test("live cleanup verifiers read bounded history instead of two collection-wide records", () => {
  for (const path of [
    "./verify-cloud-run-acceptance-clean.mjs",
    "./verify-recovered-cloud-run-acceptance.mjs",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /scribe_drop_controller_executions\?pageSize=100/u);
    assert.doesNotMatch(source, /scribe_drop_controller_executions\?pageSize=2/u);
  }
});
