import { describe, expect, it } from "vitest";

import {
  decodeCloudRunRuntimeSecret,
  parseGpuExecutionAdmission,
  parseGpuExecutionSelection,
  parseCloudRunRuntimeShadowConfig,
  parseCloudRunRuntimeServiceConfig,
  parseRetentionConfig,
  parseRunpodConfig,
  type RetentionConfigEnvironment,
  type RunpodConfigEnvironment,
} from "./config.js";

const CLOUD_RUN_CONTROLLER_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const CLOUD_RUN_DERIVATION_SECRET = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";

describe("GPU execution selection", () => {
  it("selects RunPod in every environment and the adopted Cloud Run policy remotely", () => {
    expect(
      parseGpuExecutionSelection({
        APP_ENV: "production",
        GPU_EXECUTION_POLICY: "runpod_serverless_v1",
      }),
    ).toEqual({ contractVersion: 1, kind: "runpod_serverless", policy: "runpod_serverless_v1" });
    expect(
      parseGpuExecutionSelection({
        APP_ENV: "staging",
        GPU_EXECUTION_POLICY: "cloud_run_jobs_l4_v1",
      }),
    ).toEqual({ contractVersion: 2, kind: "cloud_run_jobs", policy: "cloud_run_jobs_l4_v1" });
    expect(
      parseGpuExecutionSelection({
        APP_ENV: "production",
        GPU_EXECUTION_POLICY: "cloud_run_jobs_l4_v1",
      }),
    ).toEqual({ contractVersion: 2, kind: "cloud_run_jobs", policy: "cloud_run_jobs_l4_v1" });
  });

  it.each([
    { APP_ENV: "staging", GPU_EXECUTION_POLICY: "" },
    { APP_ENV: "local", GPU_EXECUTION_POLICY: "cloud_run_jobs_l4_v1" },
  ])("fails closed for an unavailable selection: %o", (environment) => {
    expect(parseGpuExecutionSelection(environment)).toBeUndefined();
  });
});

describe("GPU execution admission", () => {
  it("defaults to active and accepts an explicit deployment pause", () => {
    expect(parseGpuExecutionAdmission({})).toBe("active");
    expect(parseGpuExecutionAdmission({ GPU_EXECUTION_ADMISSION: "paused" })).toBe("paused");
  });

  it("fails closed for an unknown admission value", () => {
    expect(parseGpuExecutionAdmission({ GPU_EXECUTION_ADMISSION: "draining" })).toBeUndefined();
  });
});

describe("Cloud Run runtime shadow configuration", () => {
  it("accepts only the environment-specific active runtime mode", () => {
    expect(
      parseCloudRunRuntimeShadowConfig({
        APP_ENV: "staging",
        CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
      }),
    ).toEqual({ appEnvironment: "staging", mode: "synthetic-shadow" });
    expect(
      parseCloudRunRuntimeShadowConfig({
        APP_ENV: "production",
        CLOUD_RUN_RUNTIME_MODE: "active",
      }),
    ).toEqual({ appEnvironment: "production", mode: "active" });
  });

  it.each([
    { APP_ENV: "local" },
    { APP_ENV: "staging" },
    { APP_ENV: "production", CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow" },
    { APP_ENV: "staging", CLOUD_RUN_RUNTIME_MODE: "enabled" },
    { APP_ENV: "production", CLOUD_RUN_RUNTIME_MODE: "enabled" },
  ])("fails closed for an unavailable shadow route: %o", (environment) => {
    expect(parseCloudRunRuntimeShadowConfig(environment)).toBeUndefined();
  });
});

describe("Cloud Run runtime service configuration", () => {
  const valid = {
    APP_ENV: "staging",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: CLOUD_RUN_CONTROLLER_SECRET,
    CLOUD_RUN_CONTROLLER_ORIGIN:
      "https://scribe-drop-staging-gpu-controller-123456789012.asia-southeast1.run.app",
    CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-staging.example.invalid",
    CLOUD_RUN_RUNTIME_DERIVATION_SECRET: CLOUD_RUN_DERIVATION_SECRET,
    CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
    CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_BUCKET_NAME: "recording-transcriber-staging",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
  };

  it("normalizes exact roots and accepts canonical 256-bit secrets", () => {
    expect(parseCloudRunRuntimeServiceConfig(valid)).toMatchObject({
      appEnvironment: "staging",
      controllerOrigin:
        "https://scribe-drop-staging-gpu-controller-123456789012.asia-southeast1.run.app/",
      mode: "synthetic-shadow",
      orchestratorOrigin: "https://orchestrator-staging.example.invalid/",
    });
    expect(decodeCloudRunRuntimeSecret(CLOUD_RUN_CONTROLLER_SECRET)?.byteLength).toBe(32);
  });

  it("accepts isolated production runtime settings", () => {
    expect(
      parseCloudRunRuntimeServiceConfig({
        ...valid,
        APP_ENV: "production",
        CLOUD_RUN_CONTROLLER_ORIGIN:
          "https://scribe-drop-production-gpu-controller-123456789012.asia-southeast1.run.app",
        CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-production.example.invalid",
        CLOUD_RUN_RUNTIME_MODE: "active",
        CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT:
          "gpu-runtime-production@scribe-drop.iam.gserviceaccount.com",
        R2_BUCKET_NAME: "recording-transcriber-production",
      }),
    ).toMatchObject({ appEnvironment: "production", mode: "active" });
  });

  it.each([
    { APP_ENV: "production" },
    { CLOUD_RUN_RUNTIME_MODE: "disabled" },
    { CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: `${CLOUD_RUN_CONTROLLER_SECRET}=` },
    { CLOUD_RUN_RUNTIME_DERIVATION_SECRET: CLOUD_RUN_CONTROLLER_SECRET },
    { CLOUD_RUN_RUNTIME_DERIVATION_SECRET: "short" },
    { CLOUD_RUN_CONTROLLER_ORIGIN: "https://example.invalid" },
    { CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-staging.example.invalid/path" },
    { CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "default@scribe-drop.iam.gserviceaccount.com" },
    { APP_ENV: "production", CLOUD_RUN_RUNTIME_MODE: "active" },
  ])("fails closed before service composition for config drift: %o", (override) => {
    expect(parseCloudRunRuntimeServiceConfig({ ...valid, ...override })).toBeUndefined();
  });
});

const WORKER_IMAGE = "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64);

function retentionEnvironment(
  overrides: Partial<RetentionConfigEnvironment> = {},
): RetentionConfigEnvironment {
  return {
    AUDIT_RETENTION_DAYS: "180",
    MULTIPART_RETENTION_HOURS: "24",
    RESULT_RETENTION_DAYS: "90",
    SOURCE_RETENTION_DAYS: "7",
    ...overrides,
  };
}

describe("retention configuration", () => {
  it("parses the documented defaults as bounded integers", () => {
    expect(parseRetentionConfig(retentionEnvironment())).toEqual({
      auditRetentionDays: 180,
      multipartRetentionHours: 24,
      resultRetentionDays: 90,
      sourceRetentionDays: 7,
    });
  });

  it.each([
    { SOURCE_RETENTION_DAYS: "0" },
    { RESULT_RETENTION_DAYS: "90.5" },
    { AUDIT_RETENTION_DAYS: "unbounded" },
    { MULTIPART_RETENTION_HOURS: "721" },
    { SOURCE_RETENTION_DAYS: "91" },
    { RESULT_RETENTION_DAYS: "181" },
  ])("fails closed for invalid or contradictory retention values: %o", (override) => {
    expect(parseRetentionConfig(retentionEnvironment(override))).toBeUndefined();
  });
});

function runpodEnvironment(
  overrides: Partial<RunpodConfigEnvironment> = {},
): RunpodConfigEnvironment {
  return {
    APP_ENV: "staging",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_BUCKET_NAME: "recording-transcriber-staging",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
    RUNPOD_ALLOWED_GPU_IDS:
      "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition",
    RUNPOD_API_KEY: "runpod-api-key-placeholder",
    RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
    RUNPOD_INTERNAL_BASE_URL: "https://orchestrator-staging.example.invalid",
    RUNPOD_WORKER_IMAGE: WORKER_IMAGE,
    ...overrides,
  };
}

describe("RunPod placement policy configuration", () => {
  it("parses a bounded GPU allowlist and immutable candidate image", () => {
    expect(parseRunpodConfig(runpodEnvironment())).toMatchObject({
      runpodAllowedGpuTypeIds: [
        "NVIDIA GeForce RTX 5090",
        "NVIDIA GeForce RTX 4090",
        "NVIDIA RTX PRO 6000 Blackwell Server Edition",
      ],
      runpodWorkerImage: WORKER_IMAGE,
    });
  });

  it.each([
    { RUNPOD_ALLOWED_GPU_IDS: "" },
    { RUNPOD_ALLOWED_GPU_IDS: "NVIDIA A40,NVIDIA A40" },
    { RUNPOD_ALLOWED_GPU_IDS: "NVIDIA A40,NVIDIA L4,NVIDIA A30,NVIDIA A100" },
    { RUNPOD_WORKER_IMAGE: "ghcr.io/example/scribe-drop-runpod-worker:latest" },
    {
      RUNPOD_WORKER_IMAGE: "docker.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64),
    },
  ])("fails closed for an invalid placement policy: %o", (override) => {
    expect(parseRunpodConfig(runpodEnvironment(override))).toBeUndefined();
  });
});
