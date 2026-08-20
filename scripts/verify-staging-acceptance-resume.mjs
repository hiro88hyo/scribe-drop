import { readFileSync } from "node:fs";
import process from "node:process";

import { verifyStagingAcceptanceResume } from "./staging-acceptance-resume.mjs";

const [runPath, jobsPath] = process.argv.slice(2);

try {
  if (runPath === undefined || jobsPath === undefined || process.argv.length !== 4) {
    throw new Error("Usage: verify-staging-acceptance-resume <run-json> <jobs-json>");
  }
  const result = verifyStagingAcceptanceResume(
    JSON.parse(readFileSync(runPath, "utf8")),
    JSON.parse(readFileSync(jobsPath, "utf8")),
    {
      candidateRunId: process.env.CANDIDATE_RUN_ID,
      releaseBranch: process.env.EXPECTED_RELEASE_BRANCH,
      repository: process.env.GITHUB_REPOSITORY,
      sourceRunId: process.env.SOURCE_STAGING_RUN_ID,
    },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging acceptance resume is invalid");
  process.exitCode = 1;
}
