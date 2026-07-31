import { createHash } from "node:crypto";

import { validateRunpodPlan } from "./runpod-environment-config.mjs";

const digestPattern = /^[0-9a-f]{64}$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return parsed;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedCors(untrustedCors, webOrigin, environment) {
  const cors = structuredClone(requireRecord(untrustedCors, "R2 CORS policy"));
  if (
    !Array.isArray(cors.rules) ||
    cors.rules.length !== 1 ||
    cors.rules[0]?.id !== `scribe-drop-browser-multipart-${environment}` ||
    !Array.isArray(cors.rules[0]?.allowed?.origins) ||
    cors.rules[0].allowed.origins.length !== 1 ||
    cors.rules[0].allowed.origins[0] !== webOrigin
  ) {
    throw new Error("R2 CORS policy does not match the environment");
  }
  cors.rules[0].id = "scribe-drop-browser-multipart-$ENVIRONMENT";
  cors.rules[0].allowed.origins = ["$WEB_ORIGIN"];
  return cors;
}

function normalizedLifecycle(untrustedLifecycle, environment) {
  const lifecycle = structuredClone(requireRecord(untrustedLifecycle, "R2 lifecycle policy"));
  if (!Array.isArray(lifecycle.rules) || lifecycle.rules.length !== 2) {
    throw new Error("R2 lifecycle policy is invalid");
  }
  const expectedIds = new Set([
    `scribe-drop-incoming-retention-${environment}`,
    `scribe-drop-results-retention-${environment}`,
  ]);
  for (const rule of lifecycle.rules) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      typeof rule.id !== "string" ||
      !expectedIds.delete(rule.id)
    ) {
      throw new Error("R2 lifecycle policy contains an invalid environment rule");
    }
    rule.id = rule.id.replace(`-${environment}`, "-$ENVIRONMENT");
  }
  if (expectedIds.size !== 0) {
    throw new Error("R2 lifecycle policy is incomplete");
  }
  lifecycle.rules.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return lifecycle;
}

function normalizedRunpodPlan(untrustedPlan, environment) {
  const plan = validateRunpodPlan(untrustedPlan, environment);
  return {
    imageVisibility: plan.imageVisibility,
    template: {
      image: plan.template.image,
      serverless: plan.template.serverless,
      containerDiskInGb: plan.template.containerDiskInGb,
      ports: plan.template.ports,
      volumeInGb: plan.template.volumeInGb,
      environment: {
        APP_ENV: "$ENVIRONMENT",
        ORCHESTRATOR_ORIGIN: "$ORCHESTRATOR_ORIGIN",
        ALLOWED_SOURCE_HOSTS: "$R2_HOST",
        ALLOWED_RESULT_HOSTS: "$R2_HOST",
        MAX_SOURCE_BYTES: plan.template.environment.MAX_SOURCE_BYTES,
        MAX_DURATION_SECONDS: plan.template.environment.MAX_DURATION_SECONDS,
        HEARTBEAT_INTERVAL_SECONDS: plan.template.environment.HEARTBEAT_INTERVAL_SECONDS,
        MODEL_PATH: plan.template.environment.MODEL_PATH,
      },
    },
    endpoint: {
      computeType: plan.endpoint.computeType,
      compliance: [...plan.endpoint.compliance],
      dataCenterIds: [...plan.endpoint.dataCenterIds],
      gpuTypeIds: [...plan.endpoint.gpuTypeIds],
      gpuCount: plan.endpoint.gpuCount,
      workersMin: plan.endpoint.workersMin,
      workersMax: plan.endpoint.workersMax,
      idleTimeoutSeconds: plan.endpoint.idleTimeoutSeconds,
      executionTimeoutSeconds: plan.endpoint.executionTimeoutSeconds,
      minCudaVersion: plan.endpoint.minCudaVersion,
      scalerType: plan.endpoint.scalerType,
      scalerValue: plan.endpoint.scalerValue,
      flashBoot: plan.endpoint.flashBoot,
      networkVolumeIds: plan.endpoint.networkVolumeIds,
    },
  };
}

export function createEnvironmentPolicy(input) {
  if (input.environment !== "staging" && input.environment !== "production") {
    throw new Error("Environment parity policy requires staging or production");
  }
  const retention = {
    auditRetentionDays: requirePositiveInteger(
      input.retention.auditRetentionDays,
      "AUDIT_RETENTION_DAYS",
    ),
    multipartRetentionHours: requirePositiveInteger(
      input.retention.multipartRetentionHours,
      "MULTIPART_RETENTION_HOURS",
    ),
    resultRetentionDays: requirePositiveInteger(
      input.retention.resultRetentionDays,
      "RESULT_RETENTION_DAYS",
    ),
    sourceRetentionDays: requirePositiveInteger(
      input.retention.sourceRetentionDays,
      "SOURCE_RETENTION_DAYS",
    ),
  };
  if (
    retention.sourceRetentionDays > retention.resultRetentionDays ||
    retention.resultRetentionDays > retention.auditRetentionDays
  ) {
    throw new Error("Environment retention policy order is invalid");
  }
  return {
    schemaVersion: 1,
    cloudflare: {
      cors: normalizedCors(input.cors, input.webOrigin, input.environment),
      lifecycle: normalizedLifecycle(input.lifecycle, input.environment),
      retention,
    },
    runpod: normalizedRunpodPlan(input.runpodPlan, input.environment),
  };
}

export function environmentPolicyId(input) {
  return createHash("sha256")
    .update(canonicalJson(createEnvironmentPolicy(input)))
    .digest("hex");
}

export function requireEnvironmentPolicyId(value, name = "Environment policy ID") {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}
