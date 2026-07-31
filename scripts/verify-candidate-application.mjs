import path from "node:path";
import process from "node:process";

import { verifyCandidateApplicationArtifact } from "./release-candidate.mjs";

const [applicationArtifactDirectory] = process.argv.slice(2);

try {
  if (applicationArtifactDirectory === undefined || process.argv.length !== 3) {
    throw new Error("Usage: verify-candidate-application <application-artifact-directory>");
  }
  verifyCandidateApplicationArtifact(path.resolve(applicationArtifactDirectory));
  console.log("Verified candidate application artifact");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to verify candidate application artifact",
  );
  process.exitCode = 1;
}
