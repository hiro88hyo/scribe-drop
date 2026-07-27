import path from "node:path";
import process from "node:process";

import { createReleaseCandidate } from "./release-candidate.mjs";

const [
  outputDirectory,
  orchestratorBundleDirectory,
  runpodImageReferencePath,
  acceptanceFixtureDirectory,
  supplyChainDirectory,
] = process.argv.slice(2);
const commitSha = process.env["GITHUB_SHA"];

try {
  if (
    outputDirectory === undefined ||
    orchestratorBundleDirectory === undefined ||
    runpodImageReferencePath === undefined ||
    acceptanceFixtureDirectory === undefined ||
    supplyChainDirectory === undefined ||
    process.argv.length !== 7
  ) {
    throw new Error(
      "Usage: create-release-candidate <output-directory> <orchestrator-bundle-directory> <runpod-image-reference> <acceptance-fixture-directory> <supply-chain-directory>",
    );
  }
  const manifest = createReleaseCandidate({
    acceptanceFixtureDirectory: path.resolve(acceptanceFixtureDirectory),
    commitSha,
    orchestratorBundleDirectory: path.resolve(orchestratorBundleDirectory),
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
