import assert from "node:assert/strict";
import test from "node:test";

import { verifyStagingDispatchUniqueness } from "./staging-dispatch-uniqueness.mjs";

const commit = "a".repeat(40);
const run = {
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
