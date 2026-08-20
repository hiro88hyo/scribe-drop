import { describe, expect, it } from "vitest";

import fixture from "../fixtures/cloud-run-runtime-v1.json";
import {
  cloudRunBootstrapRequestSchema,
  cloudRunClaimRequestSchema,
  cloudRunClaimResponseSchema,
  cloudRunTerminalRequestSchema,
} from "./cloud-run-runtime.js";

describe("Cloud Run one-shot runtime contracts", () => {
  it("accepts only the fixed bootstrap identity fields", () => {
    const valid = fixture.bootstrapRequest;

    expect(cloudRunBootstrapRequestSchema.safeParse(valid).success).toBe(true);
    expect(cloudRunBootstrapRequestSchema.safeParse({ ...valid, image: "override" }).success).toBe(
      false,
    );
    expect(cloudRunBootstrapRequestSchema.safeParse({ ...valid, taskAttempt: 1 }).success).toBe(
      false,
    );
  });

  it("binds claim signatures to one challenge identity without accepting a token again", () => {
    const claim = fixture.claimRequest;

    expect(cloudRunClaimRequestSchema.safeParse(claim).success).toBe(true);
    expect(
      cloudRunClaimRequestSchema.safeParse({ ...claim, challenge: "x".repeat(43) }).success,
    ).toBe(false);
  });

  it("requires exact v2 options and selected capability sets", () => {
    const response = fixture.claimResponse;

    expect(cloudRunClaimResponseSchema.safeParse(response).success).toBe(true);
    expect(
      cloudRunClaimResponseSchema.safeParse({
        ...response,
        options: { ...response.options, outputFormats: ["json", "markdown"] },
      }).success,
    ).toBe(false);
  });

  it("distinguishes successful, partial-failure, and contradictory terminal reports", () => {
    const base = {
      executionHandle: "h".repeat(43),
      sequence: 4,
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      sessionToken: "t".repeat(43),
      durationSeconds: 100,
      segmentCount: 10,
    };

    expect(
      cloudRunTerminalRequestSchema.safeParse({
        ...base,
        status: "succeeded",
        artifactCount: 2,
        manifestWritten: true,
        errorCode: null,
      }).success,
    ).toBe(true);
    expect(
      cloudRunTerminalRequestSchema.safeParse({
        ...base,
        status: "failed",
        artifactCount: 1,
        manifestWritten: false,
        errorCode: "ARTIFACT_UPLOAD_FAILED",
      }).success,
    ).toBe(true);
    expect(
      cloudRunTerminalRequestSchema.safeParse({
        ...base,
        status: "succeeded",
        artifactCount: 2,
        manifestWritten: false,
        errorCode: null,
      }).success,
    ).toBe(false);
  });
});
