import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  createCandidateApplicationArtifact,
  createReleaseCandidate,
  hashArtifactDirectory,
  validateReleaseCandidateManifest,
  verifyCandidateApplicationArtifact,
  verifyReleaseCandidate,
} from "./release-candidate.mjs";

const temporaryDirectories = [];
const commitSha = "a".repeat(40);
const imageDigest = "b".repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-candidate-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixture(root, relativePath, contents) {
  const pathname = path.join(root, relativePath);
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, contents);
}

function candidateInputs() {
  const repositoryRoot = temporaryDirectory();
  writeFixture(repositoryRoot, "package.json", '{"version":"0.1.0"}\n');
  writeFixture(repositoryRoot, "apps/web/dist/index.html", "web");
  writeFixture(repositoryRoot, "apps/web/.wrangler/functions-build/index.js", "export default {};");
  writeFixture(repositoryRoot, "migrations/0001.sql", "SELECT 1;\n");
  const acceptanceFixtureDirectory = path.join(repositoryRoot, "acceptance-fixtures-build");
  writeFixture(repositoryRoot, "acceptance-fixtures-build/android.m4a", "synthetic-media");
  const supplyChainDirectory = path.join(repositoryRoot, "supply-chain-build");
  writeFixture(repositoryRoot, "supply-chain-build/runpod-worker.spdx.json", "{}\n");
  writeFixture(repositoryRoot, "supply-chain-build/runpod-worker-trivy.txt", "clean\n");
  const orchestratorBundleDirectory = path.join(repositoryRoot, "orchestrator-build");
  writeFixture(repositoryRoot, "orchestrator-build/index.js", "export default {};");
  const runpodImageReferencePath = path.join(repositoryRoot, "runpod-worker-image.txt");
  writeFixture(
    repositoryRoot,
    "runpod-worker-image.txt",
    `ghcr.io/example/scribe-drop-runpod-worker@sha256:${imageDigest}\n`,
  );
  const applicationArtifactDirectory = path.join(repositoryRoot, "candidate-application");
  createCandidateApplicationArtifact({
    orchestratorBundleDirectory,
    outputDirectory: applicationArtifactDirectory,
    repositoryRoot,
  });
  return {
    acceptanceFixtureDirectory,
    applicationArtifactDirectory,
    commitSha,
    orchestratorBundleDirectory,
    outputDirectory: path.join(repositoryRoot, "candidate"),
    repositoryRoot,
    runpodImageReferencePath,
    supplyChainDirectory,
  };
}

test("creates and verifies a deterministic release candidate", () => {
  const inputs = candidateInputs();
  const manifest = createReleaseCandidate(inputs);
  assert.equal(manifest.commitSha, commitSha);
  assert.equal(manifest.policyVersion, "adr-0023-v2");
  assert.equal(manifest.releaseVersion, "0.1.0");
  assert.equal(manifest.runpodWorker.digest, imageDigest);
  assert.equal(manifest.artifacts.acceptanceFixtures.fileCount, 1);
  assert.equal(manifest.artifacts.supplyChain.fileCount, 2);
  assert.equal(manifest.artifacts.pagesFunctions.path, "pages-functions");

  const verified = verifyReleaseCandidate({
    candidateDirectory: inputs.outputDirectory,
    expectedCommitSha: commitSha,
    expectedReleaseVersion: "0.1.0",
  });
  assert.deepEqual(verified, manifest);
});

test("rejects modified candidate artifacts", () => {
  const inputs = candidateInputs();
  createReleaseCandidate(inputs);
  writeFixture(inputs.outputDirectory, "web-assets/index.html", "modified");
  assert.throws(
    () =>
      verifyReleaseCandidate({
        candidateDirectory: inputs.outputDirectory,
        expectedCommitSha: commitSha,
      }),
    /artifact verification failed/u,
  );
});

test("rejects a multipart upload body as the Orchestrator module", () => {
  const inputs = candidateInputs();
  const multipartBody = [
    "------formdata-undici-test",
    'Content-Disposition: form-data; name="metadata"',
    "",
    '{"main_module":"index.js"}',
    "------formdata-undici-test--",
  ].join("\n");
  writeFixture(inputs.repositoryRoot, "orchestrator-build/index.js", multipartBody);
  assert.throws(
    () =>
      createCandidateApplicationArtifact({
        orchestratorBundleDirectory: inputs.orchestratorBundleDirectory,
        outputDirectory: path.join(inputs.repositoryRoot, "invalid-candidate-application"),
        repositoryRoot: inputs.repositoryRoot,
      }),
    /raw JavaScript module \(multipart upload envelope\)/u,
  );

  writeFixture(inputs.applicationArtifactDirectory, "orchestrator/index.js", multipartBody);
  assert.throws(
    () => createReleaseCandidate(inputs),
    /raw JavaScript module \(multipart upload envelope\)/u,
  );
});

test("accepts Wrangler's minified named default export", () => {
  const inputs = candidateInputs();
  writeFixture(
    inputs.applicationArtifactDirectory,
    "orchestrator/index.js",
    "var worker={fetch(){return new Response()}};export{worker as default};",
  );
  assert.doesNotThrow(() =>
    verifyCandidateApplicationArtifact(inputs.applicationArtifactDirectory),
  );
});

test("rejects unexpected candidate application files", () => {
  const inputs = candidateInputs();
  writeFixture(inputs.applicationArtifactDirectory, "orchestrator/index.js.map", "{}");
  assert.throws(
    () => verifyCandidateApplicationArtifact(inputs.applicationArtifactDirectory),
    /Orchestrator layout is invalid/u,
  );
});

test("rejects a candidate for another commit", () => {
  const inputs = candidateInputs();
  createReleaseCandidate(inputs);
  assert.throws(
    () =>
      verifyReleaseCandidate({
        candidateDirectory: inputs.outputDirectory,
        expectedCommitSha: "c".repeat(40),
      }),
    /commit does not match/u,
  );
});

test("rejects unexpected manifest fields", () => {
  const inputs = candidateInputs();
  createReleaseCandidate(inputs);
  const value = JSON.parse(
    readFileSync(path.join(inputs.outputDirectory, "candidate-manifest.json"), "utf8"),
  );
  value.unexpected = true;
  assert.throws(() => validateReleaseCandidateManifest(value), /unexpected or missing fields/u);
});

test("rejects unexpected candidate root entries", () => {
  const inputs = candidateInputs();
  createReleaseCandidate(inputs);
  writeFixture(inputs.outputDirectory, "unreviewed.txt", "unexpected");
  assert.throws(
    () => verifyReleaseCandidate({ candidateDirectory: inputs.outputDirectory }),
    /unexpected or missing entries/u,
  );
});

test("artifact directory hashes include paths and bytes", () => {
  const first = temporaryDirectory();
  const second = temporaryDirectory();
  writeFixture(first, "a/value.txt", "same");
  writeFixture(second, "b/value.txt", "same");
  assert.notEqual(hashArtifactDirectory(first).sha256, hashArtifactDirectory(second).sha256);
});
