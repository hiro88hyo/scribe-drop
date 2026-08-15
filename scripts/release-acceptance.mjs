import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import { verifyReleaseCandidate } from "./release-candidate.mjs";

const schemaVersion = 4;
const policyVersion = "adr-0086-v1";
const sha256Pattern = /^[0-9a-f]{64}$/u;
const commitShaPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const maximumEvidenceAgeMilliseconds = 24 * 60 * 60 * 1_000;
const requiredCheckNames = [
  "artifactsDownloaded",
  "candidateVerified",
  "cloudRunCandidateVerified",
  "cloudRunEndToEndM4a",
  "cloudRunProviderStorageCleaned",
  "cloudRunResourcesCleaned",
  "cloudflareResourceReadback",
  "endToEndM4a",
  "jobCleanupRequested",
  "manifestLast",
  "migrationsApplied",
  "runpodEndpointReadback",
];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name) {
  const record = requireRecord(value, name);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains unexpected or missing fields`);
  }
  return record;
}

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireTimestamp(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} is missing or invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireChecks(value) {
  const checks = requireExactKeys(value, requiredCheckNames, "Staging acceptance checks");
  for (const name of requiredCheckNames) {
    if (checks[name] !== true) {
      throw new Error(`Staging acceptance check did not pass: ${name}`);
    }
  }
  return Object.fromEntries(requiredCheckNames.map((name) => [name, true]));
}

export function validateStagingAcceptance(value) {
  const evidence = requireExactKeys(
    value,
    [
      "acceptedAt",
      "candidateId",
      "candidateRunId",
      "checks",
      "cloudRunCandidate",
      "commitSha",
      "environment",
      "environmentPolicyId",
      "expiresAt",
      "policyVersion",
      "schemaVersion",
      "stagingRunId",
    ],
    "Staging acceptance evidence",
  );
  if (evidence.schemaVersion !== schemaVersion) {
    throw new Error("Staging acceptance schema version is invalid");
  }
  if (evidence.policyVersion !== policyVersion) {
    throw new Error("Staging acceptance policy version is invalid");
  }
  if (evidence.environment !== "staging") {
    throw new Error("Staging acceptance environment is invalid");
  }
  const cloudRunCandidate = parseCloudRunCandidateEvidence(evidence.cloudRunCandidate);
  const acceptedAt = requireTimestamp(evidence.acceptedAt, "Staging acceptance time");
  const expiresAt = requireTimestamp(evidence.expiresAt, "Staging acceptance expiry");
  const lifetime = new Date(expiresAt).getTime() - new Date(acceptedAt).getTime();
  if (lifetime <= 0 || lifetime > maximumEvidenceAgeMilliseconds) {
    throw new Error("Staging acceptance lifetime is invalid");
  }
  return {
    schemaVersion,
    policyVersion,
    environment: "staging",
    environmentPolicyId: requirePattern(
      evidence.environmentPolicyId,
      sha256Pattern,
      "Staging environment policy ID",
    ),
    candidateId: requirePattern(
      evidence.candidateId,
      sha256Pattern,
      "Staging acceptance candidate ID",
    ),
    commitSha: requirePattern(evidence.commitSha, commitShaPattern, "Staging acceptance commit"),
    candidateRunId: requirePattern(
      evidence.candidateRunId,
      runIdPattern,
      "Staging acceptance candidate run ID",
    ),
    cloudRunCandidate,
    stagingRunId: requirePattern(
      evidence.stagingRunId,
      runIdPattern,
      "Staging acceptance workflow run ID",
    ),
    acceptedAt,
    expiresAt,
    checks: requireChecks(evidence.checks),
  };
}

export function createStagingAcceptance(input) {
  const manifest = verifyReleaseCandidate({
    candidateDirectory: input.candidateDirectory,
    expectedCommitSha: input.commitSha,
    expectedReleaseVersion: input.expectedReleaseVersion,
  });
  const acceptedAtDate = new Date(input.acceptedAt ?? new Date());
  const cloudRunCandidate = parseCloudRunCandidateEvidence(
    JSON.parse(readFileSync(input.cloudRunCandidateEvidencePath, "utf8")),
  );
  if (cloudRunCandidate.commit !== manifest.commitSha) {
    throw new Error("Cloud Run candidate does not match the release candidate");
  }
  const evidence = validateStagingAcceptance({
    schemaVersion,
    policyVersion,
    environment: "staging",
    environmentPolicyId: input.environmentPolicyId,
    candidateId: manifest.candidateId,
    commitSha: manifest.commitSha,
    candidateRunId: input.candidateRunId,
    cloudRunCandidate,
    stagingRunId: input.stagingRunId,
    acceptedAt: acceptedAtDate.toISOString(),
    expiresAt: new Date(acceptedAtDate.getTime() + maximumEvidenceAgeMilliseconds).toISOString(),
    checks: Object.fromEntries(requiredCheckNames.map((name) => [name, true])),
  });
  writeFileSync(input.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return evidence;
}

export function verifyStagingAcceptance(input) {
  const evidence = validateStagingAcceptance(JSON.parse(readFileSync(input.evidencePath, "utf8")));
  const manifest = verifyReleaseCandidate({
    candidateDirectory: input.candidateDirectory,
    expectedCommitSha: input.expectedCommitSha,
    expectedReleaseVersion: input.expectedReleaseVersion,
  });
  if (evidence.candidateId !== manifest.candidateId || evidence.commitSha !== manifest.commitSha) {
    throw new Error("Staging acceptance does not match the release candidate");
  }
  if (evidence.cloudRunCandidate.commit !== manifest.commitSha) {
    throw new Error("Staging acceptance Cloud Run candidate does not match");
  }
  if (
    input.expectedCloudRunCandidateRunId !== undefined &&
    evidence.cloudRunCandidate.runId !== input.expectedCloudRunCandidateRunId
  ) {
    throw new Error("Staging acceptance Cloud Run candidate run does not match");
  }
  if (
    input.expectedCandidateRunId !== undefined &&
    evidence.candidateRunId !== input.expectedCandidateRunId
  ) {
    throw new Error("Staging acceptance candidate run does not match");
  }
  if (
    input.expectedEnvironmentPolicyId !== undefined &&
    evidence.environmentPolicyId !== input.expectedEnvironmentPolicyId
  ) {
    throw new Error("Staging acceptance environment policy does not match");
  }
  if (
    input.expectedStagingRunId !== undefined &&
    evidence.stagingRunId !== input.expectedStagingRunId
  ) {
    throw new Error("Staging acceptance workflow run does not match");
  }
  const now = new Date(input.now ?? new Date());
  const expiresAt = new Date(evidence.expiresAt).getTime();
  if (
    input.minimumRemainingMilliseconds !== undefined &&
    (!Number.isSafeInteger(input.minimumRemainingMilliseconds) ||
      input.minimumRemainingMilliseconds < 0 ||
      input.minimumRemainingMilliseconds > maximumEvidenceAgeMilliseconds)
  ) {
    throw new Error("Minimum staging acceptance remaining time is invalid");
  }
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() < new Date(evidence.acceptedAt).getTime() ||
    now.getTime() >= expiresAt
  ) {
    throw new Error("Staging acceptance evidence is not currently valid");
  }
  if (
    input.minimumRemainingMilliseconds !== undefined &&
    expiresAt - now.getTime() < input.minimumRemainingMilliseconds
  ) {
    throw new Error("Staging acceptance evidence does not have enough validity remaining");
  }
  return { evidence, manifest };
}

export function parseMinimumAcceptanceRemainingMilliseconds(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("Minimum staging acceptance remaining seconds is invalid");
  }
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maximumEvidenceAgeMilliseconds) {
    throw new Error("Minimum staging acceptance remaining seconds is invalid");
  }
  return milliseconds;
}

export function acceptanceEvidencePath(directory) {
  return path.join(directory, "staging-acceptance.json");
}
