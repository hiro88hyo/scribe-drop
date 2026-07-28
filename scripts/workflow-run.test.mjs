import assert from "node:assert/strict";
import { test } from "node:test";

import { validateTrustedCiWorkflowRuns, validateTrustedWorkflowRun } from "./workflow-run.mjs";

const expected = {
  branch: "release/0.1.0",
  commitSha: "a".repeat(40),
  repository: "example/scribe-drop",
  runId: "123",
  workflowPath: ".github/workflows/publish-runpod-worker.yml",
};
const run = {
  conclusion: "success",
  event: "workflow_dispatch",
  head_branch: expected.branch,
  head_sha: expected.commitSha,
  id: 123,
  path: expected.workflowPath,
  repository: { full_name: expected.repository },
  status: "completed",
};

test("accepts an exact successful manually dispatched workflow run", () => {
  assert.deepEqual(validateTrustedWorkflowRun(run, expected), {
    branch: expected.branch,
    commitSha: expected.commitSha,
    runId: expected.runId,
    workflowPath: expected.workflowPath,
  });
});

test("rejects workflow, commit, branch, repository, and conclusion mismatches", () => {
  for (const mutation of [
    { ...run, conclusion: "failure" },
    { ...run, event: "push" },
    { ...run, head_branch: "develop" },
    { ...run, head_sha: "b".repeat(40) },
    { ...run, id: 999 },
    { ...run, path: ".github/workflows/other.yml" },
    { ...run, repository: { full_name: "other/repository" } },
    { ...run, status: "in_progress" },
  ]) {
    assert.throws(
      () => validateTrustedWorkflowRun(mutation, expected),
      /does not match|not a trusted successful run/u,
    );
  }
});

test("accepts a successful CI pull request run for the exact release commit", () => {
  const ciRun = {
    ...run,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
  };
  assert.deepEqual(
    validateTrustedCiWorkflowRuns(
      {
        workflow_runs: [{ invalid: true }, ciRun],
      },
      {
        ...expected,
        workflowPath: ".github/workflows/ci.yml",
      },
    ),
    {
      branch: expected.branch,
      commitSha: expected.commitSha,
      runId: expected.runId,
      workflowPath: ".github/workflows/ci.yml",
    },
  );
});

test("rejects CI results that do not prove the exact release commit", () => {
  for (const mutation of [
    { ...run, event: "push", path: ".github/workflows/ci.yml" },
    { ...run, conclusion: "failure", event: "pull_request", path: ".github/workflows/ci.yml" },
    {
      ...run,
      event: "pull_request",
      head_sha: "b".repeat(40),
      path: ".github/workflows/ci.yml",
    },
    {
      ...run,
      event: "pull_request",
      path: ".github/workflows/other.yml",
    },
  ]) {
    assert.throws(
      () =>
        validateTrustedCiWorkflowRuns(
          { workflow_runs: [mutation] },
          {
            ...expected,
            workflowPath: ".github/workflows/ci.yml",
          },
        ),
      /No trusted successful CI workflow run/u,
    );
  }
});
