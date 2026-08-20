import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { acceptanceEvidencePath, validateStagingAcceptance } from "./release-acceptance.mjs";

const [evidenceDirectory] = process.argv.slice(2);

try {
  if (evidenceDirectory === undefined || process.argv.length !== 3) {
    throw new Error("Usage: export-staging-acceptance-identity <evidence-directory>");
  }
  const githubEnvironmentPath = process.env["GITHUB_ENV"];
  if (githubEnvironmentPath === undefined) {
    throw new Error("GITHUB_ENV is missing");
  }
  const evidence = validateStagingAcceptance(
    JSON.parse(readFileSync(acceptanceEvidencePath(path.resolve(evidenceDirectory)), "utf8")),
  );
  appendFileSync(githubEnvironmentPath, `CANDIDATE_RUN_ID=${evidence.candidateRunId}\n`, "utf8");
  appendFileSync(
    githubEnvironmentPath,
    `CLOUD_RUN_CANDIDATE_RUN_ID=${evidence.cloudRunCandidate.runId}\n`,
    "utf8",
  );
  appendFileSync(githubEnvironmentPath, `CANDIDATE_COMMIT_SHA=${evidence.commitSha}\n`, "utf8");
  console.log("Validated staging acceptance identity.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to export staging acceptance identity",
  );
  process.exitCode = 1;
}
