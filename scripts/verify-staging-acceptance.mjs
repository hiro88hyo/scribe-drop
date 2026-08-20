import path from "node:path";
import process from "node:process";

import {
  acceptanceEvidencePath,
  parseMinimumAcceptanceRemainingMilliseconds,
  verifyStagingAcceptance,
} from "./release-acceptance.mjs";

const [candidateDirectory, evidenceDirectory] = process.argv.slice(2);

try {
  if (
    candidateDirectory === undefined ||
    evidenceDirectory === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error("Usage: verify-staging-acceptance <candidate-directory> <evidence-directory>");
  }
  const result = verifyStagingAcceptance({
    candidateDirectory: path.resolve(candidateDirectory),
    evidencePath: acceptanceEvidencePath(path.resolve(evidenceDirectory)),
    expectedCandidateRunId: process.env["EXPECTED_CANDIDATE_RUN_ID"],
    expectedCloudRunCandidateRunId: process.env["EXPECTED_CLOUD_RUN_CANDIDATE_RUN_ID"],
    expectedCommitSha: process.env["EXPECTED_COMMIT_SHA"],
    expectedEnvironmentPolicyId: process.env["EXPECTED_ENVIRONMENT_POLICY_ID"],
    expectedReleaseVersion: process.env["EXPECTED_RELEASE_VERSION"],
    expectedStagingRunId: process.env["EXPECTED_STAGING_RUN_ID"],
    minimumRemainingMilliseconds: parseMinimumAcceptanceRemainingMilliseconds(
      process.env["MINIMUM_ACCEPTANCE_REMAINING_SECONDS"],
    ),
  });
  console.log(`Verified staging acceptance for candidate ${result.evidence.candidateId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to verify staging acceptance");
  process.exitCode = 1;
}
