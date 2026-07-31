import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readCandidateFixture } from "../apps/e2e/candidate-fixture.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const e2eDirectory = path.join(repositoryRoot, "apps", "e2e");
const candidateDirectory = process.env.RELEASE_CANDIDATE_DIRECTORY;

if (candidateDirectory === undefined || candidateDirectory.length === 0) {
  throw new Error("RELEASE_CANDIDATE_DIRECTORY is required");
}
if (!path.isAbsolute(candidateDirectory)) {
  throw new Error("RELEASE_CANDIDATE_DIRECTORY must be an absolute path");
}

const originalDirectory = process.cwd();
try {
  process.chdir(e2eDirectory);
  const fixture = readCandidateFixture(candidateDirectory);
  if (fixture.length === 0) {
    throw new Error("Release candidate acceptance fixture is empty");
  }
} finally {
  process.chdir(originalDirectory);
}

process.stdout.write("Staging E2E candidate fixture preflight passed.\n");
