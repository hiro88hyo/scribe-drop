import path from "node:path";
import process from "node:process";

import { createCandidateApplicationArtifact } from "./release-candidate.mjs";

const [outputDirectory, orchestratorBundleDirectory] = process.argv.slice(2);

try {
  if (
    outputDirectory === undefined ||
    orchestratorBundleDirectory === undefined ||
    process.argv.length !== 4
  ) {
    throw new Error(
      "Usage: create-candidate-application <output-directory> <orchestrator-bundle-directory>",
    );
  }
  const resolvedOutput = path.resolve(outputDirectory);
  createCandidateApplicationArtifact({
    orchestratorBundleDirectory: path.resolve(orchestratorBundleDirectory),
    outputDirectory: resolvedOutput,
    repositoryRoot: path.resolve(import.meta.dirname, ".."),
  });
  console.log("Created candidate application artifact");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to create candidate application artifact",
  );
  process.exitCode = 1;
}
