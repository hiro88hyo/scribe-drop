import { describe, expect, it } from "vitest";

import {
  parseRetentionConfig,
  parseRunpodConfig,
  type RetentionConfigEnvironment,
  type RunpodConfigEnvironment,
} from "./config.js";

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
      "NVIDIA GeForce RTX 5090,NVIDIA RTX PRO 4500 Blackwell,NVIDIA GeForce RTX 4090",
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
        "NVIDIA RTX PRO 4500 Blackwell",
        "NVIDIA GeForce RTX 4090",
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
