import process from "node:process";

import { verifyStagingResumeInputs } from "./staging-resume-inputs.mjs";

try {
  console.log(
    JSON.stringify(
      verifyStagingResumeInputs({
        candidateCommitSha: process.env.CANDIDATE_COMMIT_SHA,
        preflightOnly: process.env.PREFLIGHT_ONLY,
        resumeAcceptanceOnly: process.env.RESUME_ACCEPTANCE_ONLY,
        sourceRunId: process.env.SOURCE_STAGING_RUN_ID,
      }),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging resume inputs are invalid");
  process.exitCode = 1;
}
