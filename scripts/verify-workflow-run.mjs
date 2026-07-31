import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateTrustedWorkflowRun } from "./workflow-run.mjs";

const [metadataPath, workflowPath, runId] = process.argv.slice(2);

try {
  if (
    metadataPath === undefined ||
    workflowPath === undefined ||
    runId === undefined ||
    process.argv.length !== 5
  ) {
    throw new Error("Usage: verify-workflow-run <metadata-path> <workflow-path> <run-id>");
  }
  const commitSha = process.env["EXPECTED_COMMIT_SHA"];
  const branch = process.env["EXPECTED_RELEASE_BRANCH"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (commitSha === undefined || branch === undefined || repository === undefined) {
    throw new Error("Required GitHub workflow identity is missing");
  }
  const result = validateTrustedWorkflowRun(
    JSON.parse(readFileSync(path.resolve(metadataPath), "utf8")),
    {
      branch,
      commitSha,
      repository,
      runId,
      workflowPath,
    },
  );
  console.log(`Verified trusted workflow run ${result.runId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to verify GitHub workflow run");
  process.exitCode = 1;
}
