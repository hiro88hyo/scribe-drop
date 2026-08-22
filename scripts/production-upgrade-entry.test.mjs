import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProductionReleaseArtifact,
  verifyProductionUpgradeEntry,
} from "./production-upgrade-entry.mjs";

const runId = "123";
const commitSha = "a".repeat(40);
const cutoverRunId = "456";
const run = {
  conclusion: "success",
  display_title: "Production finalize from staging run 789",
  event: "workflow_dispatch",
  head_branch: "release/0.2.0",
  head_sha: "b".repeat(40),
  id: 123,
  path: ".github/workflows/deploy-production-candidate.yml",
  repository: { full_name: "owner/repo" },
  status: "completed",
};
const step = (name, conclusion = "success") => ({ conclusion, name, status: "completed" });
const job = (name, conclusion, steps = []) => ({ conclusion, name, status: "completed", steps });
const jobs = {
  jobs: [
    job("Verify immutable candidate, acceptance, and operation inputs", "success", [
      step("Verify immutable cutover evidence for finalize"),
    ]),
    job("Cut over safely and open exactly one production smoke slot", "skipped"),
    job("Verify production smoke and open the reviewed operating window", "success", [
      step("Verify exact finalize entry state before mutation"),
      step("Verify final parity, Access, and accepted artifact identity"),
      step("Record immutable production release evidence"),
      step("Upload immutable production release evidence"),
    ]),
  ],
  total_count: 3,
};
const evidence = {
  checks: {
    accessReadback: true,
    artifactAndNotification: true,
    cloudflareReadback: true,
    environmentParity: true,
    providerCleanup: true,
  },
  commitSha,
  cutoverRunId,
  environment: "production",
  finalizeEntryStage: "smoke-paused",
  finalizeRunId: runId,
  operationalAuthorization: {
    maxExecutions: 5,
    maxWorstCaseJpy: 1250,
    validUntil: "2026-08-21T00:00:00.000Z",
    worstCaseJpyPerExecution: 250,
  },
  provider: "cloud_run_jobs_l4_v1",
  schemaVersion: 2,
  smokeJobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  stagingRunId: "789",
};
const expected = { repository: "owner/repo", runId };

test("resolves one unexpired bounded previous release artifact", () => {
  const name = `scribe-drop-production-release-${commitSha}-${runId}`;
  assert.equal(
    resolveProductionReleaseArtifact(
      run,
      { artifacts: [{ expired: false, name, size_in_bytes: 563 }], total_count: 1 },
      expected,
    ),
    name,
  );
  assert.throws(
    () =>
      resolveProductionReleaseArtifact(
        run,
        { artifacts: [{ expired: true, name, size_in_bytes: 563 }], total_count: 1 },
        expected,
      ),
    /not unique/u,
  );
});

test("exports only an expired successful production operational entry", () => {
  assert.deepEqual(
    verifyProductionUpgradeEntry(
      run,
      jobs,
      evidence,
      expected,
      new Date("2026-08-22T00:00:00.000Z"),
    ),
    {
      commitSha,
      cutoverRunId,
      epoch: `phase16-operational-${commitSha}-${cutoverRunId}`,
      maxExecutions: 5,
      maxWorstCaseJpy: 1250,
      validUntil: "2026-08-21T00:00:00.000Z",
    },
  );
  assert.throws(
    () =>
      verifyProductionUpgradeEntry(
        run,
        jobs,
        evidence,
        expected,
        new Date("2026-08-20T00:00:00.000Z"),
      ),
    /must be expired/u,
  );
});

test("rejects an incomplete prior finalize prefix", () => {
  const regressed = structuredClone(jobs);
  regressed.jobs[2].steps[1].conclusion = "failure";
  assert.throws(
    () =>
      verifyProductionUpgradeEntry(
        run,
        regressed,
        evidence,
        expected,
        new Date("2026-08-22T00:00:00.000Z"),
      ),
    /final parity/u,
  );
});
