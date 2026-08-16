import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionPromotionInputs } from "./production-promotion-inputs.mjs";

const defaults = {
  candidateCommitSha: "a".repeat(40),
  cutoverRunId: "0",
  operation: "cutover",
  operationalMaxExecutions: "0",
  operationalMaxWorstCaseJpy: "0",
  operationalValidUntil: "1970-01-01T00:00:00.000Z",
  productionSmokeJobId: "none",
  preflightOnly: "false",
  preflightRunId: "789",
  stagingRunId: "123",
};

test("accepts cutover only with inert finalize inputs", () => {
  assert.deepEqual(validateProductionPromotionInputs(defaults), {
    candidateCommitSha: "a".repeat(40),
    operation: "cutover",
    preflightOnly: false,
    preflightRunId: "789",
    stagingRunId: "123",
  });
  assert.deepEqual(
    validateProductionPromotionInputs({
      ...defaults,
      preflightOnly: "true",
      preflightRunId: "0",
    }),
    {
      candidateCommitSha: "a".repeat(40),
      operation: "cutover",
      preflightOnly: true,
      preflightRunId: "0",
      stagingRunId: "123",
    },
  );
  assert.throws(
    () => validateProductionPromotionInputs({ ...defaults, cutoverRunId: "456" }),
    /must not include/u,
  );
});

test("accepts an explicit bounded finalize budget", () => {
  assert.deepEqual(
    validateProductionPromotionInputs(
      {
        ...defaults,
        cutoverRunId: "456",
        operation: "finalize",
        operationalMaxExecutions: "5",
        operationalMaxWorstCaseJpy: "1250",
        operationalValidUntil: "2026-08-15T23:00:00.000Z",
        productionSmokeJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        preflightRunId: "0",
      },
      new Date("2026-08-15T00:00:00.000Z"),
    ),
    {
      candidateCommitSha: "a".repeat(40),
      cutoverRunId: "456",
      maxExecutions: 5,
      maxWorstCaseJpy: 1250,
      operation: "finalize",
      preflightOnly: false,
      preflightRunId: "0",
      productionSmokeJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      stagingRunId: "123",
      validUntil: "2026-08-15T23:00:00.000Z",
    },
  );
});

test("rejects a mismatched, excessive, or expired budget", () => {
  const finalize = {
    ...defaults,
    cutoverRunId: "456",
    operation: "finalize",
    operationalMaxExecutions: "5",
    operationalMaxWorstCaseJpy: "1249",
    operationalValidUntil: "2026-08-15T23:00:00.000Z",
    productionSmokeJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    preflightRunId: "0",
  };
  assert.throws(
    () => validateProductionPromotionInputs(finalize, new Date("2026-08-15T00:00:00.000Z")),
    /250 JPY/u,
  );
  assert.throws(
    () =>
      validateProductionPromotionInputs(
        {
          ...finalize,
          operationalMaxWorstCaseJpy: "1250",
          operationalValidUntil: "2026-08-15T00:20:00.000Z",
        },
        new Date("2026-08-15T00:00:00.000Z"),
      ),
    /outside the reviewed window/u,
  );
  assert.throws(
    () =>
      validateProductionPromotionInputs({
        ...finalize,
        operationalMaxWorstCaseJpy: "1250",
        preflightOnly: "true",
      }),
    /Finalize cannot run/u,
  );
  assert.throws(
    () => validateProductionPromotionInputs({ ...defaults, candidateCommitSha: "main" }),
    /candidate identity/u,
  );
});
