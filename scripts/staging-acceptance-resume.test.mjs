import assert from "node:assert/strict";
import test from "node:test";

import { verifyStagingAcceptanceResume } from "./staging-acceptance-resume.mjs";

const expected = {
  candidateRunId: "99",
  releaseBranch: "release/0.2.0",
  repository: "owner/repository",
  sourceRunId: "123",
};

function step(name, conclusion = "success") {
  return { conclusion, name, status: "completed" };
}

function job(name, conclusion, steps = []) {
  return { conclusion, name, status: "completed", steps };
}

const acceptanceSteps = [
  step("Verify candidate and live resource read-back"),
  step("Verify authenticated data plane, then run real staging M4A lifecycle"),
  step("Preserve only unresolved fixture identity for automatic recovery"),
  step("Verify exact-one Cloud Run cleanup and provider storage convergence", "failure"),
  step("Disable staging controller authorization after cleanup", "skipped"),
  step("Restore RunPod selection while preserving the Cloud Run reaper", "skipped"),
  step("Verify final disabled zero state before issuing acceptance", "skipped"),
  step("Issue short-lived staging acceptance", "skipped"),
  step("Upload immutable staging acceptance", "skipped"),
];

const recoverySteps = [
  step("Wait for the deployed reaper and Cloud Run resources to converge"),
  step("Disable only this failed run's staging controller authorization"),
  step("Reactivate RunPod only after Cloud Run is disabled and empty"),
  step("Verify recovered staging safety without issuing acceptance"),
  step("Reject any incomplete automatic recovery action"),
];

function fixture() {
  const jobs = [
    job("Verify candidate and all remote prerequisites", "success"),
    job("Apply candidate D1 migrations", "skipped"),
    job("Promote exact candidate Pages deployment", "skipped"),
    job("Promote R2, RunPod, and Orchestrator", "skipped"),
    job(
      "Verify live resources and run real staging acceptance",
      "failure",
      structuredClone(acceptanceSteps),
    ),
    job(
      "Converge a failed staging acceptance to the safe state",
      "success",
      structuredClone(recoverySteps),
    ),
  ];
  return {
    jobs: { jobs, total_count: jobs.length },
    run: {
      conclusion: "failure",
      display_title: "Deploy candidate from run 99 to staging",
      event: "workflow_dispatch",
      head_branch: "release/0.2.0",
      head_sha: "a".repeat(40),
      id: 123,
      path: ".github/workflows/deploy-staging-candidate.yml",
      repository: { full_name: "owner/repository" },
      run_attempt: 1,
      status: "completed",
    },
  };
}

test("accepts only a recovered source run whose real lifecycle succeeded", () => {
  const value = fixture();
  assert.deepEqual(verifyStagingAcceptanceResume(value.run, value.jobs, expected), {
    headSha: "a".repeat(40),
    recoveryRequiresLiveReverification: false,
    sourceRunId: "123",
  });
});

test("accepts a full staging source whose promotion jobs all succeeded", () => {
  const value = fixture();
  for (const index of [1, 2, 3]) value.jobs.jobs[index].conclusion = "success";
  assert.deepEqual(verifyStagingAcceptanceResume(value.run, value.jobs, expected), {
    headSha: "a".repeat(40),
    recoveryRequiresLiveReverification: false,
    sourceRunId: "123",
  });
});

test("rejects mixed promotion conclusions in the source lifecycle", () => {
  const value = fixture();
  value.jobs.jobs[1].conclusion = "success";
  assert.throws(
    () => verifyStagingAcceptanceResume(value.run, value.jobs, expected),
    /promotion jobs are inconsistent/u,
  );
});

test("accepts a recovered source whose final aggregation is reverified live", () => {
  const value = fixture();
  value.jobs.jobs[5].conclusion = "failure";
  value.jobs.jobs[5].steps[4].conclusion = "failure";
  assert.deepEqual(verifyStagingAcceptanceResume(value.run, value.jobs, expected), {
    headSha: "a".repeat(40),
    recoveryRequiresLiveReverification: true,
    sourceRunId: "123",
  });
});

test("rejects a failed lifecycle or incomplete recovery", () => {
  const lifecycleFailure = fixture();
  lifecycleFailure.jobs.jobs[4].steps[1].conclusion = "failure";
  assert.throws(
    () => verifyStagingAcceptanceResume(lifecycleFailure.run, lifecycleFailure.jobs, expected),
    /M4A lifecycle did not finish with success/u,
  );

  const recoveryFailure = fixture();
  recoveryFailure.jobs.jobs[5].steps[1].conclusion = "failure";
  assert.throws(
    () => verifyStagingAcceptanceResume(recoveryFailure.run, recoveryFailure.jobs, expected),
    /controller authorization did not finish with success/u,
  );
});
