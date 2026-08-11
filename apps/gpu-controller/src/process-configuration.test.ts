import { describe, expect, it } from "vitest";

import { parseControllerProcessEnvironment } from "./process-configuration.js";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function environment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "staging",
    PORT: "8080",
    SCRIBE_DROP_CLOUD_RUN_IMAGE_DIGEST: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
    SCRIBE_DROP_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "runtime@scribe-phase14.iam.gserviceaccount.com",
    SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY: encode(new Uint8Array(32).fill(1)),
    SCRIBE_DROP_FIRESTORE_DATABASE_ID: "scribe-staging-controller",
    SCRIBE_DROP_GCP_PROJECT_ID: "scribe-phase14",
    SCRIBE_DROP_ORCHESTRATOR_ORIGIN: "https://orchestrator.example.test/",
    SCRIBE_DROP_RESULT_HOST: "storage.example.test",
    SCRIBE_DROP_SOURCE_HOST: "storage.example.test",
  };
}

describe("controller process configuration", () => {
  it("defaults to the exact disabled authorization without reading unrelated variables", async () => {
    const parsed = parseControllerProcessEnvironment({
      ...environment(),
      UNRELATED_PLATFORM_VALUE: "ignored",
    });

    expect(parsed.port).toBe(8080);
    expect(parsed.runtime.authorization).toEqual({
      environment: "staging",
      epoch: "disabled",
      maxExecutions: 0,
      maxRequestsPerMinute: 0,
      maxWorstCaseJpy: 0,
      validUntil: "1970-01-01T00:00:00.000Z",
      worstCaseJpyPerExecution: 0,
    });
    expect(await parsed.keys.get("secondary")).toBeNull();
  });

  it("accepts only a complete coherent finite authorization", () => {
    const parsed = parseControllerProcessEnvironment({
      ...environment(),
      SCRIBE_DROP_AUTHORIZATION_EPOCH: "staging-review-2026-08-11",
      SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS: "1",
      SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE: "10",
      SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY: "500",
      SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL: "2026-08-12T00:00:00.000Z",
      SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION: "500",
    });

    expect(parsed.runtime.authorization).toMatchObject({
      epoch: "staging-review-2026-08-11",
      maxExecutions: 1,
      maxWorstCaseJpy: 500,
    });
  });

  it("rejects partial authorization, noncanonical numbers, and missing secrets", () => {
    expect(() =>
      parseControllerProcessEnvironment({
        ...environment(),
        SCRIBE_DROP_AUTHORIZATION_EPOCH: "partial",
      }),
    ).toThrow("all present or all absent");
    expect(() => parseControllerProcessEnvironment({ ...environment(), PORT: "08080" })).toThrow();
    const missingSecret = environment();
    delete missingSecret["SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY"];
    expect(() => parseControllerProcessEnvironment(missingSecret)).toThrow(
      "missing controller setting",
    );
  });
});
