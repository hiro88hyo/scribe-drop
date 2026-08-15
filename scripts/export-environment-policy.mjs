import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { environmentPolicyId } from "./environment-parity.mjs";

export function exportEnvironmentPolicy({
  environment,
  variables = process.env,
  workingDirectory = process.cwd(),
}) {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Usage: export-environment-policy <staging|production>");
  }
  const githubEnvironmentPath = variables["GITHUB_ENV"];
  if (githubEnvironmentPath === undefined) {
    throw new Error("GITHUB_ENV is missing");
  }
  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}`;
  const webOrigin = variables[`${prefix}_WEB_ORIGIN`];
  if (webOrigin === undefined) {
    throw new Error(`${prefix}_WEB_ORIGIN is missing`);
  }
  const readJson = (relativePath) =>
    JSON.parse(readFileSync(path.resolve(workingDirectory, relativePath), "utf8"));
  const cloudRunCandidatePath = variables["CLOUD_RUN_CANDIDATE_EVIDENCE_PATH"];
  if (cloudRunCandidatePath === undefined) {
    throw new Error("CLOUD_RUN_CANDIDATE_EVIDENCE_PATH is missing");
  }
  const policyId = environmentPolicyId({
    environment,
    cloudRunCandidate: readJson(cloudRunCandidatePath),
    cloudRunRuntimeMode: variables[`${prefix}_CLOUD_RUN_RUNTIME_MODE`],
    cors: readJson(`.wrangler/deploy/r2-cors-${environment}.json`),
    lifecycle: readJson(`.wrangler/deploy/r2-lifecycle-${environment}.json`),
    retention: {
      auditRetentionDays: variables["AUDIT_RETENTION_DAYS"],
      multipartRetentionHours: variables["MULTIPART_RETENTION_HOURS"],
      resultRetentionDays: variables["RESULT_RETENTION_DAYS"],
      sourceRetentionDays: variables["SOURCE_RETENTION_DAYS"],
    },
    runpodPlan: readJson(`.runpod/deploy/${environment}-plan.json`),
    gpuExecutionPolicy: variables[`${prefix}_GPU_EXECUTION_POLICY`],
    gpuExecutionAdmission: variables[`${prefix}_GPU_EXECUTION_ADMISSION`],
    webOrigin,
  });
  appendFileSync(
    githubEnvironmentPath,
    `ENVIRONMENT_POLICY_ID=${policyId}\nEXPECTED_ENVIRONMENT_POLICY_ID=${policyId}\n`,
    "utf8",
  );
  console.log(`Exported normalized ${environment} environment policy identity.`);
  return policyId;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const [environment] = process.argv.slice(2);
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: export-environment-policy <staging|production>");
    }
    exportEnvironmentPolicy({ environment });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Failed to export environment policy identity",
    );
    process.exitCode = 1;
  }
}
