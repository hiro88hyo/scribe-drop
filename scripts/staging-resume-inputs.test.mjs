import assert from "node:assert/strict";
import test from "node:test";

import { verifyStagingResumeInputs } from "./staging-resume-inputs.mjs";

test("requires acceptance-only mode and an exact candidate for recovered evidence", () => {
  assert.deepEqual(
    verifyStagingResumeInputs({
      candidateCommitSha: "a".repeat(40),
      preflightOnly: "false",
      resumeAcceptanceOnly: "true",
      sourceRunId: "123",
    }),
    { recoveredAcceptance: true, sourceRunId: "123" },
  );
  assert.deepEqual(verifyStagingResumeInputs({ sourceRunId: "" }), {
    recoveredAcceptance: false,
  });
  assert.throws(
    () =>
      verifyStagingResumeInputs({
        candidateCommitSha: "a".repeat(40),
        preflightOnly: "true",
        resumeAcceptanceOnly: "true",
        sourceRunId: "123",
      }),
    /inputs are invalid/u,
  );
});
