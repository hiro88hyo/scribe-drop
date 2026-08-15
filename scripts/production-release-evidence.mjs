import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/u;
const runPattern = /^[1-9][0-9]*$/u;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function requireTimestamp(value) {
  if (typeof value !== "string") throw new Error("Production authorization expiry is invalid");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Production authorization expiry is invalid");
  }
  return value;
}

export function validateProductionReleaseEvidence(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "checks,commitSha,cutoverRunId,environment,finalizeRunId,operationalAuthorization,provider,schemaVersion,smokeJobId,stagingRunId" ||
    value.schemaVersion !== 1 ||
    value.environment !== "production" ||
    value.provider !== "cloud_run_jobs_l4_v1" ||
    !commitPattern.test(value.commitSha) ||
    !runPattern.test(value.stagingRunId) ||
    !runPattern.test(value.cutoverRunId) ||
    !runPattern.test(value.finalizeRunId) ||
    !ulidPattern.test(value.smokeJobId)
  ) {
    throw new Error("Production release evidence is invalid");
  }
  const authorization = value.operationalAuthorization;
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    Array.isArray(authorization) ||
    Object.keys(authorization).sort().join(",") !==
      "maxExecutions,maxWorstCaseJpy,validUntil,worstCaseJpyPerExecution" ||
    !Number.isSafeInteger(authorization.maxExecutions) ||
    authorization.maxExecutions < 1 ||
    authorization.maxExecutions > 20 ||
    authorization.maxWorstCaseJpy !== authorization.maxExecutions * 250 ||
    authorization.worstCaseJpyPerExecution !== 250
  ) {
    throw new Error("Production release authorization evidence is invalid");
  }
  requireTimestamp(authorization.validUntil);
  const expectedChecks = [
    "accessReadback",
    "artifactAndNotification",
    "cloudflareReadback",
    "environmentParity",
    "providerCleanup",
  ];
  if (
    typeof value.checks !== "object" ||
    value.checks === null ||
    Array.isArray(value.checks) ||
    Object.keys(value.checks).sort().join(",") !== expectedChecks.sort().join(",") ||
    expectedChecks.some((name) => value.checks[name] !== true)
  ) {
    throw new Error("Production release checks are invalid");
  }
  return structuredClone(value);
}

function positiveInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, directory] = process.argv.slice(2);
  try {
    if (!new Set(["create", "verify"]).has(command) || directory === undefined) {
      throw new Error("Usage: production-release-evidence <create|verify> <directory>");
    }
    const evidencePath = path.resolve(directory, "production-release.json");
    if (command === "create") {
      const maxExecutions = positiveInteger(
        process.env.OPERATIONAL_MAX_EXECUTIONS,
        "Operational maximum executions",
      );
      const evidence = validateProductionReleaseEvidence({
        checks: {
          accessReadback: true,
          artifactAndNotification: true,
          cloudflareReadback: true,
          environmentParity: true,
          providerCleanup: true,
        },
        commitSha: process.env.GITHUB_SHA,
        cutoverRunId: process.env.CUTOVER_RUN_ID,
        environment: "production",
        finalizeRunId: process.env.GITHUB_RUN_ID,
        operationalAuthorization: {
          maxExecutions,
          maxWorstCaseJpy: positiveInteger(
            process.env.OPERATIONAL_MAX_WORST_CASE_JPY,
            "Operational maximum worst-case JPY",
          ),
          validUntil: process.env.OPERATIONAL_VALID_UNTIL,
          worstCaseJpyPerExecution: 250,
        },
        provider: "cloud_run_jobs_l4_v1",
        schemaVersion: 1,
        smokeJobId: process.env.PRODUCTION_SMOKE_JOB_ID,
        stagingRunId: process.env.STAGING_RUN_ID,
      });
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
    }
    const evidence = validateProductionReleaseEvidence(
      JSON.parse(readFileSync(evidencePath, "utf8")),
    );
    console.log(`Verified production release run ${evidence.finalizeRunId}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production release evidence failed");
    process.exitCode = 1;
  }
}
