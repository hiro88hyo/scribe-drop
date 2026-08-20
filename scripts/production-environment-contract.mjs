import {
  renderOrchestratorProductionConfig,
  renderR2CorsProductionConfig,
  renderR2LifecycleProductionConfig,
  renderWebProductionConfig,
} from "./cloudflare-environment-config.mjs";
import { environmentPolicyId, requireEnvironmentPolicyId } from "./environment-parity.mjs";
import { createRunpodProductionPlan } from "./runpod-environment-config.mjs";

export const requiredProductionVariableNames = [
  "AUDIT_RETENTION_DAYS",
  "CLOUDFLARE_ACCOUNT_ID",
  "MULTIPART_RETENTION_HOURS",
  "RESULT_RETENTION_DAYS",
  "SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE",
  "SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN",
  "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION",
  "SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID",
  "SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN",
  "SCRIBE_DROP_PRODUCTION_PAGES_PROJECT",
  "SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS",
  "SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE_VISIBILITY",
  "SCRIBE_DROP_PRODUCTION_RUNPOD_REGISTRY_AUTH_ID",
  "SCRIBE_DROP_PRODUCTION_WEB_ORIGIN",
  "SOURCE_RETENTION_DAYS",
];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function productionVariables(untrustedVariables) {
  if (!Array.isArray(untrustedVariables)) {
    throw new Error("Production Environment variables are invalid");
  }
  const variables = new Map();
  for (const untrustedVariable of untrustedVariables) {
    const variable = requireRecord(untrustedVariable, "Production Environment variable");
    if (
      typeof variable.name !== "string" ||
      typeof variable.value !== "string" ||
      variables.has(variable.name)
    ) {
      throw new Error("Production Environment variables are invalid");
    }
    variables.set(variable.name, variable.value);
  }
  const observedNames = [...variables.keys()].sort();
  const expectedNames = [...requiredProductionVariableNames].sort();
  if (
    observedNames.length !== expectedNames.length ||
    observedNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Production Environment variables do not match the reviewed set");
  }
  return Object.fromEntries(variables);
}

export function verifyProductionEnvironmentContract({
  cloudRunCandidate,
  expectedEnvironmentPolicyId,
  runpodWorkerImage,
  templates,
  variables: untrustedVariables,
}) {
  const variables = productionVariables(untrustedVariables);
  const failures = [];
  const capture = (operation) => {
    try {
      return operation();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Production contract is invalid");
      return undefined;
    }
  };
  const pagesProject = variables.SCRIBE_DROP_PRODUCTION_PAGES_PROJECT;
  if (pagesProject !== "scribe-drop-web-production") {
    failures.push("Production Pages project does not match the reviewed target");
  }
  if (
    !/^[1-9][0-9]*$/u.test(
      variables.SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION,
    )
  ) {
    failures.push("Production controller HMAC secret version is invalid");
  }
  const identifiers = {
    accessAudience: variables.SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE,
    accessTeamDomain: variables.SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN,
    accountId: variables.CLOUDFLARE_ACCOUNT_ID,
    auditRetentionDays: variables.AUDIT_RETENTION_DAYS,
    candidateMigrationsDirectory: "../../release-candidate/migrations",
    cloudRunRuntimeMode: "disabled",
    d1DatabaseId: variables.SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID,
    gpuExecutionAdmission: "paused",
    gpuExecutionPolicy: "runpod_serverless_v1",
    multipartRetentionHours: variables.MULTIPART_RETENTION_HOURS,
    orchestratorOrigin: variables.SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN,
    resultRetentionDays: variables.RESULT_RETENTION_DAYS,
    runpodAllowedGpuTypeIds: variables.SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS,
    runpodWorkerImage,
    sourceRetentionDays: variables.SOURCE_RETENTION_DAYS,
    webOrigin: variables.SCRIBE_DROP_PRODUCTION_WEB_ORIGIN,
  };
  capture(() => renderOrchestratorProductionConfig(templates.orchestrator, identifiers));
  capture(() => renderWebProductionConfig(templates.web, identifiers));
  const cors = capture(() => JSON.parse(renderR2CorsProductionConfig(templates.cors, identifiers)));
  const lifecycle = capture(() =>
    JSON.parse(renderR2LifecycleProductionConfig(templates.lifecycle, identifiers)),
  );
  const runpodPlan = capture(() =>
    createRunpodProductionPlan({
      accountId: variables.CLOUDFLARE_ACCOUNT_ID,
      gpuTypeIds: variables.SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS,
      image: runpodWorkerImage,
      imageVisibility: variables.SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE_VISIBILITY,
      orchestratorOrigin: variables.SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN,
      registryAuthId: variables.SCRIBE_DROP_PRODUCTION_RUNPOD_REGISTRY_AUTH_ID,
    }),
  );
  const policyId =
    cors === undefined || lifecycle === undefined || runpodPlan === undefined
      ? undefined
      : capture(() =>
          environmentPolicyId({
            cloudRunCandidate,
            cloudRunRuntimeMode: "active",
            cors,
            environment: "production",
            gpuExecutionAdmission: "active",
            gpuExecutionPolicy: "cloud_run_jobs_l4_v1",
            lifecycle,
            retention: {
              auditRetentionDays: variables.AUDIT_RETENTION_DAYS,
              multipartRetentionHours: variables.MULTIPART_RETENTION_HOURS,
              resultRetentionDays: variables.RESULT_RETENTION_DAYS,
              sourceRetentionDays: variables.SOURCE_RETENTION_DAYS,
            },
            runpodPlan,
            webOrigin: variables.SCRIBE_DROP_PRODUCTION_WEB_ORIGIN,
          }),
        );
  if (
    expectedEnvironmentPolicyId !== undefined &&
    policyId !== undefined &&
    policyId !==
      requireEnvironmentPolicyId(
        expectedEnvironmentPolicyId,
        "Accepted staging environment policy ID",
      )
  ) {
    failures.push("Production Environment policy does not match staging acceptance");
  }
  if (failures.length > 0) {
    throw new Error([...new Set(failures)].join("; "));
  }
  return { policyId, variableCount: requiredProductionVariableNames.length };
}
