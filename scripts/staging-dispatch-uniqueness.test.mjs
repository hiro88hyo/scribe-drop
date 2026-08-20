import assert from "node:assert/strict";
import test from "node:test";

import { verifyStagingDispatchUniqueness } from "./staging-dispatch-uniqueness.mjs";

const commit = "a".repeat(40);
const run = {
  display_title: "Deploy candidate from run 99 to staging",
  event: "workflow_dispatch",
  head_sha: commit,
  id: 123,
  path: ".github/workflows/deploy-staging-candidate.yml",
};

test("accepts only the first dispatch for a candidate commit", () => {
  assert.deepEqual(
    verifyStagingDispatchUniqueness(
      { total_count: 1, workflow_runs: [run] },
      { commit, currentRunId: "123", runAttempt: "1" },
    ),
    { priorDispatchCount: 0, runAttempt: 1 },
  );
});

test("does not consume the exact-one deployment with a mutation-free preflight", () => {
  assert.deepEqual(
    verifyStagingDispatchUniqueness(
      {
        total_count: 2,
        workflow_runs: [
          run,
          { ...run, display_title: "Preflight candidate from run 99 to staging", id: 122 },
        ],
      },
      { commit, currentRunId: "123", runAttempt: "1" },
    ),
    { priorDispatchCount: 0, runAttempt: 1 },
  );
});

test("rejects a forged mutation-free preflight identity", () => {
  assert.throws(
    () =>
      verifyStagingDispatchUniqueness(
        {
          total_count: 2,
          workflow_runs: [
            run,
            {
              ...run,
              display_title: "Preflight candidate from run 99 to staging",
              head_sha: "b".repeat(40),
              id: 122,
            },
          ],
        },
        { commit, currentRunId: "123", runAttempt: "1" },
      ),
    /preflight identity does not match/u,
  );
});

test("rejects job reruns, prior dispatches, and incomplete pagination", () => {
  assert.throws(
    () =>
      verifyStagingDispatchUniqueness(
        { total_count: 1, workflow_runs: [run] },
        { commit, currentRunId: "123", runAttempt: "2" },
      ),
    /must not be re-run/u,
  );
  assert.throws(
    () =>
      verifyStagingDispatchUniqueness(
        { total_count: 2, workflow_runs: [run, { ...run, id: 122 }] },
        { commit, currentRunId: "123", runAttempt: "1" },
      ),
    /another staging workflow dispatch/u,
  );
  assert.throws(
    () =>
      verifyStagingDispatchUniqueness(
        { total_count: 2, workflow_runs: [run] },
        { commit, currentRunId: "123", runAttempt: "1" },
      ),
    /another staging workflow dispatch/u,
  );
});
