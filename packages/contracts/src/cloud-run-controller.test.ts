import { describe, expect, it } from "vitest";

import {
  buildCloudRunControllerSigningFrame,
  canonicalizeCloudRunControllerRequest,
  cloudRunControllerAttestationRequestSchema,
  cloudRunControllerAttestationResponseSchema,
} from "./cloud-run-controller.js";

const REQUEST = {
  environment: "staging",
  executionHandle: "h".repeat(43),
  expiresAt: "2026-08-11T00:01:00.000Z",
  issuedAt: "2026-08-11T00:00:00.000Z",
  policyId: "cloud_run_jobs_l4_v1",
  requestId: "01K28000000000000000000000",
  schemaVersion: 1,
} as const;

describe("Cloud Run controller attestation contract", () => {
  it("accepts only the bounded attestation request and response", () => {
    expect(cloudRunControllerAttestationRequestSchema.parse(REQUEST)).toEqual(REQUEST);
    expect(
      cloudRunControllerAttestationRequestSchema.safeParse({ ...REQUEST, image: "override" })
        .success,
    ).toBe(false);
    expect(
      cloudRunControllerAttestationResponseSchema.parse({
        attestation: {
          activeExecutionCount: 1,
          controllerVersion: 4,
          environment: "staging",
          executionHandle: REQUEST.executionHandle,
          executionName: "execution-1",
          jobName: "job-1",
          manifestMatches: true,
          policyId: "cloud_run_jobs_l4_v1",
          retriedCount: 0,
          runtimeServiceAccount: "runtime@scribe-phase14.iam.gserviceaccount.com",
          state: "running",
          taskCount: 1,
        },
        executionHandle: REQUEST.executionHandle,
        outcome: "found",
        requestId: REQUEST.requestId,
        schemaVersion: 1,
      }),
    ).toBeDefined();
  });

  it("canonicalizes semantic request content and frames the exact path", () => {
    const reorderedRequest = {
      schemaVersion: 1,
      requestId: REQUEST.requestId,
      policyId: REQUEST.policyId,
      issuedAt: REQUEST.issuedAt,
      expiresAt: REQUEST.expiresAt,
      executionHandle: REQUEST.executionHandle,
      environment: REQUEST.environment,
    };
    expect(canonicalizeCloudRunControllerRequest(reorderedRequest)).toBe(
      canonicalizeCloudRunControllerRequest(REQUEST),
    );
    const requestDigest = "d".repeat(43);
    const first = buildCloudRunControllerSigningFrame({
      method: "POST",
      path: "/v1/executions/attest",
      request: REQUEST,
      requestDigest,
    });
    const changedPath = buildCloudRunControllerSigningFrame({
      method: "POST",
      path: "/v1/executions",
      request: REQUEST,
      requestDigest,
    });
    expect(first).toContain("21:/v1/executions/attest");
    expect(changedPath).not.toBe(first);
    expect(() =>
      buildCloudRunControllerSigningFrame({
        method: "PÖST",
        path: "/v1/executions",
        request: REQUEST,
        requestDigest,
      }),
    ).toThrow("must be ASCII");
  });
});
