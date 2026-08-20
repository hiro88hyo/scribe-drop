import { readFileSync } from "node:fs";
import process from "node:process";

import { verifyProductionPreflightRun } from "./production-preflight-run.mjs";

const [runPath, jobsPath] = process.argv.slice(2);

try {
  if (runPath === undefined || jobsPath === undefined || process.argv.length !== 4) {
    throw new Error("Usage: verify-production-preflight-run <run-json> <jobs-json>");
  }
  const result = verifyProductionPreflightRun(
    JSON.parse(readFileSync(runPath, "utf8")),
    JSON.parse(readFileSync(jobsPath, "utf8")),
    {
      preflightRunId: process.env.PRODUCTION_PREFLIGHT_RUN_ID,
      releaseBranch: process.env.EXPECTED_RELEASE_BRANCH,
      repository: process.env.GITHUB_REPOSITORY,
      stagingRunId: process.env.STAGING_RUN_ID,
      workflowCommitSha: process.env.GITHUB_SHA,
    },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production preflight run is invalid");
  process.exitCode = 1;
}
