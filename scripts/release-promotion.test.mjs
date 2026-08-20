import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { preparePagesCandidate } from "./pages-candidate.mjs";
import {
  acceptanceEvidencePath,
  createStagingAcceptance,
  validateStagingAcceptance,
  verifyStagingAcceptance,
} from "./release-acceptance.mjs";
import { createReleaseCandidate } from "./release-candidate.mjs";

const temporaryDirectories = [];
const commitSha = "a".repeat(40);
const candidateRunId = "123";
const stagingRunId = "456";
const environmentPolicyId = "c".repeat(64);
const validPagesFunctionsModule =
  'const routes=[{routePath:"/api/me"},{routePath:"/api/:path*"},{routePath:"/api"}];export default {};\n';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-promotion-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFixture(root, relativePath, contents) {
  const pathname = path.join(root, relativePath);
  mkdirSync(path.dirname(pathname), { recursive: true });
  writeFileSync(pathname, contents);
}

function createCandidate() {
  const repositoryRoot = temporaryDirectory();
  writeFixture(repositoryRoot, "package.json", '{"version":"0.1.0"}\n');
  writeFixture(repositoryRoot, "migrations/0001.sql", "SELECT 1;\n");
  writeFixture(repositoryRoot, "acceptance-fixtures/android.m4a", "synthetic-media");
  writeFixture(repositoryRoot, "supply-chain/report.txt", "clean\n");
  writeFixture(repositoryRoot, "application/web-assets/index.html", "web");
  writeFixture(repositoryRoot, "application/pages-functions/_worker.js", validPagesFunctionsModule);
  writeFixture(repositoryRoot, "application/orchestrator/index.js", "export default {};");
  writeFixture(
    repositoryRoot,
    "runpod-image.txt",
    `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}\n`,
  );
  const candidateDirectory = path.join(repositoryRoot, "candidate");
  createReleaseCandidate({
    acceptanceFixtureDirectory: path.join(repositoryRoot, "acceptance-fixtures"),
    applicationArtifactDirectory: path.join(repositoryRoot, "application"),
    commitSha,
    outputDirectory: candidateDirectory,
    repositoryRoot,
    runpodImageReferencePath: path.join(repositoryRoot, "runpod-image.txt"),
    supplyChainDirectory: path.join(repositoryRoot, "supply-chain"),
  });
  const cloudRunCandidateEvidencePath = path.join(repositoryRoot, "cloud-run-candidate.json");
  writeFileSync(
    cloudRunCandidateEvidencePath,
    `${JSON.stringify({
      commit: commitSha,
      controllerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:${"d".repeat(64)}`,
      runAttempt: "1",
      runId: "789",
      schemaVersion: 1,
      workerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"e".repeat(64)}`,
    })}\n`,
  );
  return { candidateDirectory, cloudRunCandidateEvidencePath, repositoryRoot };
}

test("assembles Pages advanced-mode output only from a verified candidate", () => {
  const { candidateDirectory, repositoryRoot } = createCandidate();
  const outputDirectory = path.join(repositoryRoot, "pages-deploy");
  preparePagesCandidate({
    candidateDirectory,
    expectedCommitSha: commitSha,
    expectedReleaseVersion: "0.1.0",
    outputDirectory,
  });
  assert.equal(readFileSync(path.join(outputDirectory, "index.html"), "utf8"), "web");
  assert.equal(
    readFileSync(path.join(outputDirectory, "_worker.js"), "utf8"),
    validPagesFunctionsModule,
  );
});

test("refuses to assemble Pages output after candidate mutation", () => {
  const { candidateDirectory, repositoryRoot } = createCandidate();
  writeFixture(candidateDirectory, "web-assets/index.html", "changed");
  assert.throws(
    () =>
      preparePagesCandidate({
        candidateDirectory,
        expectedCommitSha: commitSha,
        outputDirectory: path.join(repositoryRoot, "pages-deploy"),
      }),
    /artifact verification failed/u,
  );
  assert.equal(existsSync(path.join(repositoryRoot, "pages-deploy")), false);
});

test("creates and verifies short-lived staging acceptance evidence", () => {
  const { candidateDirectory, cloudRunCandidateEvidencePath, repositoryRoot } = createCandidate();
  const evidenceDirectory = path.join(repositoryRoot, "evidence");
  mkdirSync(evidenceDirectory);
  const acceptedAt = new Date("2026-07-27T12:00:00.000Z");
  const evidence = createStagingAcceptance({
    acceptedAt,
    candidateDirectory,
    candidateRunId,
    cloudRunCandidateEvidencePath,
    commitSha,
    environmentPolicyId,
    expectedReleaseVersion: "0.1.0",
    outputPath: acceptanceEvidencePath(evidenceDirectory),
    stagingRunId,
  });
  assert.equal(evidence.schemaVersion, 4);
  assert.equal(evidence.policyVersion, "adr-0086-v1");
  assert.equal(evidence.environment, "staging");
  assert.equal(evidence.checks.endToEndM4a, true);
  assert.equal(evidence.checks.cloudRunEndToEndM4a, true);
  assert.equal(evidence.cloudRunCandidate.runId, "789");

  const verified = verifyStagingAcceptance({
    candidateDirectory,
    evidencePath: acceptanceEvidencePath(evidenceDirectory),
    expectedCandidateRunId: candidateRunId,
    expectedCommitSha: commitSha,
    expectedEnvironmentPolicyId: environmentPolicyId,
    expectedReleaseVersion: "0.1.0",
    expectedStagingRunId: stagingRunId,
    now: new Date("2026-07-28T11:59:59.000Z"),
  });
  assert.equal(verified.evidence.candidateId, evidence.candidateId);
});

test("rejects expired, incomplete, or mismatched staging acceptance", () => {
  const { candidateDirectory, cloudRunCandidateEvidencePath, repositoryRoot } = createCandidate();
  const evidenceDirectory = path.join(repositoryRoot, "evidence");
  mkdirSync(evidenceDirectory);
  const evidencePath = acceptanceEvidencePath(evidenceDirectory);
  createStagingAcceptance({
    acceptedAt: new Date("2026-07-27T12:00:00.000Z"),
    candidateDirectory,
    candidateRunId,
    cloudRunCandidateEvidencePath,
    commitSha,
    environmentPolicyId,
    outputPath: evidencePath,
    stagingRunId,
  });
  assert.throws(
    () =>
      verifyStagingAcceptance({
        candidateDirectory,
        evidencePath,
        expectedCandidateRunId: candidateRunId,
        expectedCommitSha: commitSha,
        expectedEnvironmentPolicyId: environmentPolicyId,
        expectedStagingRunId: stagingRunId,
        now: new Date("2026-07-28T12:00:00.000Z"),
      }),
    /not currently valid/u,
  );
  assert.throws(
    () =>
      verifyStagingAcceptance({
        candidateDirectory,
        evidencePath,
        expectedCandidateRunId: "999",
        expectedCommitSha: commitSha,
        now: new Date("2026-07-27T13:00:00.000Z"),
      }),
    /candidate run does not match/u,
  );
  assert.throws(
    () =>
      verifyStagingAcceptance({
        candidateDirectory,
        evidencePath,
        expectedCommitSha: commitSha,
        expectedEnvironmentPolicyId: "d".repeat(64),
        now: new Date("2026-07-27T13:00:00.000Z"),
      }),
    /environment policy does not match/u,
  );
  assert.throws(
    () =>
      verifyStagingAcceptance({
        candidateDirectory,
        evidencePath,
        expectedCommitSha: commitSha,
        minimumRemainingMilliseconds: 30 * 60 * 1_000,
        now: new Date("2026-07-28T11:40:01.000Z"),
      }),
    /does not have enough validity remaining/u,
  );

  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.checks.manifestLast = false;
  assert.throws(() => validateStagingAcceptance(evidence), /check did not pass/u);
});

test("rejects unknown staging acceptance fields", () => {
  const { candidateDirectory, cloudRunCandidateEvidencePath, repositoryRoot } = createCandidate();
  const evidenceDirectory = path.join(repositoryRoot, "evidence");
  mkdirSync(evidenceDirectory);
  const evidencePath = acceptanceEvidencePath(evidenceDirectory);
  const evidence = createStagingAcceptance({
    acceptedAt: new Date("2026-07-27T12:00:00.000Z"),
    candidateDirectory,
    candidateRunId,
    cloudRunCandidateEvidencePath,
    commitSha,
    environmentPolicyId,
    outputPath: evidencePath,
    stagingRunId,
  });
  assert.throws(
    () => validateStagingAcceptance({ ...evidence, bypass: true }),
    /unexpected or missing fields/u,
  );
});
