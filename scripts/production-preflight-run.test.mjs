import assert from "node:assert/strict";
import test from "node:test";

import { verifyProductionPreflightRun } from "./production-preflight-run.mjs";

const expected = {
  preflightRunId: "123",
  releaseBranch: "release/0.2.0",
  repository: "owner/repository",
  stagingRunId: "456",
  workflowCommitSha: "a".repeat(40),
};

function step(name, conclusion = "success") {
  return { conclusion, name, status: "completed" };
}

function job(name, conclusion, steps = []) {
  return { conclusion, name, status: "completed", steps };
}

function fixture() {
  const jobs = [
    job("Verify immutable candidate, acceptance, and operation inputs", "success", [
      step("Validate bounded production operation inputs"),
      step("Validate release and staging run identities"),
      step("Download and inspect immutable staging evidence"),
      step("Download and verify both exact candidates"),
      step("Verify immutable cutover evidence for finalize", "skipped"),
      step("Verify successful mutation-free production preflight before cutover", "skipped"),
    ]),
    job("Cut over safely and open exactly one production smoke slot", "success", [
      step("Download acceptance and export exact candidate identity"),
      step("Download and re-verify exact candidates"),
      step("Build verifier and strictly read production foundation"),
      step("Render disabled preflight configuration"),
      step("Verify every external control plane before production mutation"),
      step("Apply candidate migrations and reviewed R2 policies", "skipped"),
      step("Promote exact rollback-compatible RunPod image without execution", "skipped"),
      step("Deploy bounded controller behind the existing RunPod selection", "skipped"),
      step("Deploy exact application candidate with admission paused", "skipped"),
      step("Drain old provider before changing new-attempt selection", "skipped"),
      step("Select Cloud Run while keeping admission paused", "skipped"),
      step("Verify exact-one L4 authorization and activate admission", "skipped"),
      step("Record immutable cutover evidence", "skipped"),
      step("Upload immutable cutover evidence", "skipped"),
    ]),
    job("Verify production smoke and open the reviewed operating window", "skipped"),
  ];
  return {
    jobs: { jobs, total_count: jobs.length },
    run: {
      conclusion: "success",
      display_title: "Production preflight from staging run 456",
      event: "workflow_dispatch",
      head_branch: "release/0.2.0",
      head_sha: "a".repeat(40),
      id: 123,
      path: ".github/workflows/deploy-production-candidate.yml",
      repository: { full_name: "owner/repository" },
      run_attempt: 1,
      status: "completed",
    },
  };
}

test("accepts only a successful mutation-free production preflight", () => {
  const value = fixture();
  assert.deepEqual(verifyProductionPreflightRun(value.run, value.jobs, expected), {
    preflightRunId: "123",
    stagingRunId: "456",
  });
});

test("rejects a preflight that ran a production mutation", () => {
  const value = fixture();
  value.jobs.jobs[1].steps[5].conclusion = "success";
  assert.throws(
    () => verifyProductionPreflightRun(value.run, value.jobs, expected),
    /migrations.*skipped/u,
  );
});
