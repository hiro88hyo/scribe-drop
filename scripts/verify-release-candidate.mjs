import path from "node:path";
import process from "node:process";

import { verifyReleaseCandidate } from "./release-candidate.mjs";

const [candidateDirectory] = process.argv.slice(2);

try {
  if (candidateDirectory === undefined || process.argv.length !== 3) {
    throw new Error("Usage: verify-release-candidate <candidate-directory>");
  }
  const manifest = verifyReleaseCandidate({
    candidateDirectory: path.resolve(candidateDirectory),
    expectedCommitSha: process.env["EXPECTED_COMMIT_SHA"],
    expectedReleaseVersion: process.env["EXPECTED_RELEASE_VERSION"],
  });
  console.log(`Verified release candidate ${manifest.candidateId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to verify release candidate");
  process.exitCode = 1;
}
