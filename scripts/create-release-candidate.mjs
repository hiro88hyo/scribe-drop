import path from "node:path";
import process from "node:process";

import { createReleaseCandidate } from "./release-candidate.mjs";

const [
  outputDirectory,
  applicationArtifactDirectory,
  runpodImageReferencePath,
  acceptanceFixtureDirectory,
  supplyChainDirectory,
] = process.argv.slice(2);
const commitSha = process.env["GITHUB_SHA"];

try {
  if (
    outputDirectory === undefined ||
    applicationArtifactDirectory === undefined ||
    runpodImageReferencePath === undefined ||
    acceptanceFixtureDirectory === undefined ||
    supplyChainDirectory === undefined ||
    process.argv.length !== 7
  ) {
    throw new Error(
      "Usage: create-release-candidate <output-directory> <application-artifact-directory> <runpod-image-reference> <acceptance-fixture-directory> <supply-chain-directory>",
    );
  }
  const manifest = createReleaseCandidate({
    acceptanceFixtureDirectory: path.resolve(acceptanceFixtureDirectory),
    applicationArtifactDirectory: path.resolve(applicationArtifactDirectory),
    commitSha,
    outputDirectory: path.resolve(outputDirectory),
    repositoryRoot: path.resolve(import.meta.dirname, ".."),
    runpodImageReferencePath: path.resolve(runpodImageReferencePath),
    supplyChainDirectory: path.resolve(supplyChainDirectory),
  });
  console.log(`Created release candidate ${manifest.candidateId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to create release candidate");
  process.exitCode = 1;
}
