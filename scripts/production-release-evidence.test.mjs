import assert from "node:assert/strict";
import test from "node:test";

import { validateProductionReleaseEvidence } from "./production-release-evidence.mjs";

function evidence() {
  return {
    checks: {
      accessReadback: true,
      artifactAndNotification: true,
      cloudflareReadback: true,
      environmentParity: true,
      providerCleanup: true,
    },
    commitSha: "a".repeat(40),
    cutoverRunId: "123",
    environment: "production",
    finalizeEntryStage: "smoke-active",
    finalizeRunId: "456",
    operationalAuthorization: {
      maxExecutions: 5,
      maxWorstCaseJpy: 1_250,
      validUntil: "2026-08-16T00:00:00.000Z",
      worstCaseJpyPerExecution: 250,
    },
    provider: "cloud_run_jobs_l4_v1",
    schemaVersion: 2,
    smokeJobId: "01J00000000000000000000000",
    stagingRunId: "100",
  };
}

test("accepts the complete production release evidence", () => {
  assert.equal(validateProductionReleaseEvidence(evidence()).provider, "cloud_run_jobs_l4_v1");
});

test("rejects an inconsistent operational budget", () => {
  const value = evidence();
  value.operationalAuthorization.maxWorstCaseJpy = 1_249;
  assert.throws(() => validateProductionReleaseEvidence(value), /authorization evidence/u);
});

test("rejects an unknown finalize entry stage", () => {
  const value = evidence();
  value.finalizeEntryStage = "unknown";
  assert.throws(() => validateProductionReleaseEvidence(value), /entry stage/u);
});
