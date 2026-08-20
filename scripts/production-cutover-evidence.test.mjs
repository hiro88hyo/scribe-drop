import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionCutoverEvidence } from "./production-cutover-evidence.mjs";

test("accepts only exact-one production cutover evidence", () => {
  const evidence = {
    commitSha: "a".repeat(40),
    cutoverRunId: "456",
    environment: "production",
    operation: "cutover",
    schemaVersion: 1,
    smokeAuthorization: "exact-one-l4-250-jpy",
    stagingRunId: "123",
  };
  assert.deepEqual(validateProductionCutoverEvidence(evidence), evidence);
  assert.throws(
    () => validateProductionCutoverEvidence({ ...evidence, smokeAuthorization: "unbounded" }),
    /invalid/u,
  );
});
