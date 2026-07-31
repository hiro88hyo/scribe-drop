import path from "node:path";
import process from "node:process";

import { preparePagesCandidate } from "./pages-candidate.mjs";

const [candidateDirectory, outputDirectory] = process.argv.slice(2);

try {
  if (
    candidateDirectory === undefined ||
    outputDirectory === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error("Usage: prepare-pages-candidate <candidate-directory> <output-directory>");
  }
  const manifest = preparePagesCandidate({
    candidateDirectory: path.resolve(candidateDirectory),
    expectedCommitSha: process.env["EXPECTED_COMMIT_SHA"],
    expectedReleaseVersion: process.env["EXPECTED_RELEASE_VERSION"],
    outputDirectory: path.resolve(outputDirectory),
  });
  console.log(`Prepared verified Pages candidate ${manifest.candidateId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to prepare Pages candidate");
  process.exitCode = 1;
}
