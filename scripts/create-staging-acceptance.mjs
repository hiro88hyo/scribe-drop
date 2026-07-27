import path from "node:path";
import process from "node:process";

import { acceptanceEvidencePath, createStagingAcceptance } from "./release-acceptance.mjs";

const [candidateDirectory, outputDirectory] = process.argv.slice(2);

try {
  if (
    candidateDirectory === undefined ||
    outputDirectory === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error("Usage: create-staging-acceptance <candidate-directory> <output-directory>");
  }
  const candidateRunId = process.env["CANDIDATE_RUN_ID"];
  const stagingRunId = process.env["GITHUB_RUN_ID"];
  const commitSha = process.env["GITHUB_SHA"];
  const environmentPolicyId = process.env["ENVIRONMENT_POLICY_ID"];
  if (
    candidateRunId === undefined ||
    stagingRunId === undefined ||
    commitSha === undefined ||
    environmentPolicyId === undefined
  ) {
    throw new Error("Required GitHub workflow identity is missing");
  }
  const evidence = createStagingAcceptance({
    candidateDirectory: path.resolve(candidateDirectory),
    candidateRunId,
    commitSha,
    environmentPolicyId,
    expectedReleaseVersion: process.env["EXPECTED_RELEASE_VERSION"],
    outputPath: acceptanceEvidencePath(path.resolve(outputDirectory)),
    stagingRunId,
  });
  console.log(`Created staging acceptance for candidate ${evidence.candidateId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to create staging acceptance");
  process.exitCode = 1;
}
