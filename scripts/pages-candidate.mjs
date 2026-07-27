import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { verifyReleaseCandidate } from "./release-candidate.mjs";

function requireFile(pathname, name) {
  if (!existsSync(pathname) || !statSync(pathname).isFile()) {
    throw new Error(`${name} is missing`);
  }
}

export function preparePagesCandidate(input) {
  if (existsSync(input.outputDirectory)) {
    throw new Error("Pages deployment output directory already exists");
  }

  const manifest = verifyReleaseCandidate({
    candidateDirectory: input.candidateDirectory,
    expectedCommitSha: input.expectedCommitSha,
    expectedReleaseVersion: input.expectedReleaseVersion,
  });
  const assetsDirectory = path.join(input.candidateDirectory, manifest.artifacts.webAssets.path);
  const workerPath = path.join(
    input.candidateDirectory,
    manifest.artifacts.pagesFunctions.path,
    "_worker.js",
  );
  requireFile(workerPath, "Candidate Pages Functions bundle");

  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o755 });
  cpSync(assetsDirectory, input.outputDirectory, {
    dereference: false,
    errorOnExist: true,
    recursive: true,
  });
  writeFileSync(path.join(input.outputDirectory, "_worker.js"), readFileSync(workerPath), {
    mode: 0o644,
  });
  return manifest;
}
