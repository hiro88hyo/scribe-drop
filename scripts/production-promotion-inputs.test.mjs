import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionPromotionInputs } from "./production-promotion-inputs.mjs";

const defaults = {
  cutoverRunId: "0",
  operation: "cutover",
  operationalMaxExecutions: "0",
  operationalMaxWorstCaseJpy: "0",
  operationalValidUntil: "1970-01-01T00:00:00.000Z",
  productionSmokeJobId: "none",
  stagingRunId: "123",
};

test("accepts cutover only with inert finalize inputs", () => {
  assert.deepEqual(validateProductionPromotionInputs(defaults), {
    operation: "cutover",
    stagingRunId: "123",
  });
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
      },
      new Date("2026-08-15T00:00:00.000Z"),
    ),
    {
      cutoverRunId: "456",
      maxExecutions: 5,
      maxWorstCaseJpy: 1250,
      operation: "finalize",
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
});
