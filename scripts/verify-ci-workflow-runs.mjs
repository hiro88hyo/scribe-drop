import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateTrustedCiWorkflowRuns } from "./workflow-run.mjs";

const metadataPath = process.argv[2];

try {
  if (metadataPath === undefined || process.argv.length !== 3) {
    throw new Error("Usage: verify-ci-workflow-runs <metadata-path>");
  }
  const commitSha = process.env["GITHUB_SHA"];
  const branch = process.env["GITHUB_REF_NAME"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (commitSha === undefined || branch === undefined || repository === undefined) {
    throw new Error("Required GitHub CI identity is missing");
  }
  const result = validateTrustedCiWorkflowRuns(
    JSON.parse(readFileSync(path.resolve(metadataPath), "utf8")),
    {
      branch,
      commitSha,
      repository,
      workflowPath: ".github/workflows/ci.yml",
    },
  );
  console.log(`Verified successful CI workflow run ${result.runId}`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to verify GitHub CI workflow runs",
  );
  process.exitCode = 1;
}
