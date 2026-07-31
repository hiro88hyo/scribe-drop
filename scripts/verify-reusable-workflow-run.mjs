import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateReusableWorkflowRun } from "./workflow-run.mjs";

const [metadataPath, workflowPath, runId] = process.argv.slice(2);

try {
  if (
    metadataPath === undefined ||
    workflowPath === undefined ||
    runId === undefined ||
    process.argv.length !== 5
  ) {
    throw new Error("Usage: verify-reusable-workflow-run <metadata-path> <workflow-path> <run-id>");
  }
  const branch = process.env["EXPECTED_RELEASE_BRANCH"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (branch === undefined || repository === undefined) {
    throw new Error("Required GitHub workflow identity is missing");
  }
  const result = validateReusableWorkflowRun(
    JSON.parse(readFileSync(path.resolve(metadataPath), "utf8")),
    {
      branch,
      repository,
      runId,
      workflowPath,
    },
  );
  process.stdout.write(`${result.commitSha}\n`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to verify reusable GitHub workflow run",
  );
  process.exitCode = 1;
}
