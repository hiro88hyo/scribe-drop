import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateProductionReleaseEvidence } from "./production-release-evidence.mjs";

const commitPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const releaseBranchPattern =
  /^release\/(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireSuccessfulFinalizeRun(run, expected) {
  const repository = requireRecord(run.repository, "Previous production repository");
  if (
    !runIdPattern.test(expected.runId) ||
    String(run.id) !== expected.runId ||
    run.path !== ".github/workflows/deploy-production-candidate.yml" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !commitPattern.test(run.head_sha) ||
    !releaseBranchPattern.test(run.head_branch) ||
    repository.full_name !== expected.repository
  ) {
    throw new Error("Previous production workflow run is not trusted");
  }
}

function requireJob(jobs, name, conclusion) {
  const matches = jobs.filter((job) => job?.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.status !== "completed" ||
    matches[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Previous production ${name} job is invalid`);
  }
  return matches[0];
}

function requireStep(job, name, conclusion) {
  const matches = Array.isArray(job.steps) ? job.steps.filter((step) => step?.name === name) : [];
  if (
    matches.length !== 1 ||
    matches[0]?.status !== "completed" ||
    matches[0]?.conclusion !== conclusion
  ) {
    throw new Error(`Previous production ${name} step is invalid`);
  }
}

export function resolveProductionReleaseArtifact(run, artifactsEnvelope, expected) {
  requireSuccessfulFinalizeRun(run, expected);
  const artifacts = Array.isArray(artifactsEnvelope?.artifacts)
    ? artifactsEnvelope.artifacts
    : undefined;
  if (artifacts === undefined || artifactsEnvelope.total_count !== artifacts.length) {
    throw new Error("Previous production artifact response is incomplete");
  }
  const pattern = new RegExp(
    `^scribe-drop-production-release-([0-9a-f]{40})-${expected.runId}$`,
    "u",
  );
  const matches = artifacts.filter(
    (artifact) =>
      typeof artifact?.name === "string" &&
      pattern.test(artifact.name) &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 64 * 1024,
  );
  if (matches.length !== 1) {
    throw new Error("Previous production release artifact is not unique and valid");
  }
  return matches[0].name;
}

export function verifyProductionUpgradeEntry(run, jobsEnvelope, evidenceValue, expected, now) {
  requireSuccessfulFinalizeRun(run, expected);
  const evidence = validateProductionReleaseEvidence(evidenceValue);
  if (
    evidence.finalizeRunId !== expected.runId ||
    run.display_title !== `Production finalize from staging run ${evidence.stagingRunId}` ||
    !Array.isArray(jobsEnvelope?.jobs) ||
    jobsEnvelope.total_count !== jobsEnvelope.jobs.length
  ) {
    throw new Error("Previous production release identity does not match its workflow");
  }
  const verification = requireJob(
    jobsEnvelope.jobs,
    "Verify immutable candidate, acceptance, and operation inputs",
    "success",
  );
  requireStep(verification, "Verify immutable cutover evidence for finalize", "success");
  requireJob(
    jobsEnvelope.jobs,
    "Cut over safely and open exactly one production smoke slot",
    "skipped",
  );
  const finalize = requireJob(
    jobsEnvelope.jobs,
    "Verify production smoke and open the reviewed operating window",
    "success",
  );
  for (const name of [
    "Verify exact finalize entry state before mutation",
    "Verify final parity, Access, and accepted artifact identity",
    "Record immutable production release evidence",
    "Upload immutable production release evidence",
  ]) {
    requireStep(finalize, name, "success");
  }
  const expiry = Date.parse(evidence.operationalAuthorization.validUntil);
  if (!Number.isFinite(now.getTime()) || expiry > now.getTime()) {
    throw new Error("Previous production authorization must be expired before upgrade cutover");
  }
  return {
    commitSha: evidence.commitSha,
    cutoverRunId: evidence.cutoverRunId,
    epoch: `phase16-operational-${evidence.commitSha}-${evidence.cutoverRunId}`,
    maxExecutions: evidence.operationalAuthorization.maxExecutions,
    maxWorstCaseJpy: evidence.operationalAuthorization.maxWorstCaseJpy,
    validUntil: evidence.operationalAuthorization.validUntil,
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, runPath, thirdPath, fourthPath] = process.argv.slice(2);
  try {
    const expected = {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.PREVIOUS_PRODUCTION_RUN_ID,
    };
    const run = JSON.parse(readFileSync(path.resolve(runPath ?? ""), "utf8"));
    if (command === "resolve" && thirdPath !== undefined && fourthPath === undefined) {
      const artifacts = JSON.parse(readFileSync(path.resolve(thirdPath), "utf8"));
      console.log(resolveProductionReleaseArtifact(run, artifacts, expected));
    } else if (command === "export" && thirdPath !== undefined && fourthPath !== undefined) {
      const jobs = JSON.parse(readFileSync(path.resolve(thirdPath), "utf8"));
      const evidence = JSON.parse(
        readFileSync(path.resolve(fourthPath, "production-release.json"), "utf8"),
      );
      const result = verifyProductionUpgradeEntry(run, jobs, evidence, expected, new Date());
      console.log(`PREVIOUS_PRODUCTION_COMMIT_SHA=${result.commitSha}`);
      console.log(`PREVIOUS_PRODUCTION_CUTOVER_RUN_ID=${result.cutoverRunId}`);
      console.log(`PREVIOUS_PRODUCTION_AUTHORIZATION_EPOCH=${result.epoch}`);
      console.log(`PREVIOUS_PRODUCTION_AUTHORIZATION_VALID_UNTIL=${result.validUntil}`);
      console.log(`PREVIOUS_PRODUCTION_MAX_EXECUTIONS=${result.maxExecutions}`);
      console.log(`PREVIOUS_PRODUCTION_MAX_WORST_CASE_JPY=${result.maxWorstCaseJpy}`);
    } else {
      throw new Error(
        "Usage: production-upgrade-entry <resolve run-json artifacts-json|export run-json jobs-json evidence-directory>",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production upgrade entry failed");
    process.exitCode = 1;
  }
}
