import { describe, expect, it } from "vitest";

import { createStructuredLogger, sanitizeLogContext } from "./index.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const FIXED_DATE = new Date("2026-07-25T00:00:00.000Z");

describe("sanitizeLogContext", () => {
  it("retains only explicitly allowed, validated fields", () => {
    expect(
      sanitizeLogContext({
        attemptId: ATTEMPT_ID,
        elapsedMs: 123,
        errorCode: "FFPROBE_INVALID_CONTAINER",
        jobId: JOB_ID,
        ownerHash: "a".repeat(32),
        requestId: "request-123",
        runpodJobId: "runpod-job-123",
        sizeBytes: 1024,
        status: "FAILED",
      }),
    ).toEqual({
      attemptId: ATTEMPT_ID,
      elapsedMs: 123,
      errorCode: "FFPROBE_INVALID_CONTAINER",
      jobId: JOB_ID,
      ownerHash: "a".repeat(32),
      requestId: "request-123",
      runpodJobId: "runpod-job-123",
      sizeBytes: 1024,
      status: "FAILED",
    });
  });

  it("drops secret-bearing fields and arbitrary nested metadata", () => {
    expect(
      sanitizeLogContext({
        accessJwt: "secret-access-jwt",
        accessKeyId: "secret-access-key",
        claimToken: "secret-claim-token",
        discordWebhookUrl: "https://discord.example.invalid/secret",
        email: "person@example.invalid",
        error: new Error("secret error detail"),
        filename: "private-recording-name.m4a",
        jobId: JOB_ID,
        metadata: {
          transcript: "secret transcript body",
        },
        presignedUrl: "https://storage.example.invalid/source?signature=secret",
        secretAccessKey: "secret-r2-key",
        sessionToken: "secret-r2-session",
        sourceKey: `incoming/private-owner/${JOB_ID}/private-nonce/source.m4a`,
        title: "private meeting title",
        transcript: "secret transcript body",
        webhookToken: "secret-webhook-token",
      }),
    ).toEqual({ jobId: JOB_ID });
  });

  it("drops unsafe values even when they use an allowed field name", () => {
    expect(
      sanitizeLogContext({
        elapsedMs: Number.NaN,
        errorCode: "https://storage.example.invalid/?signature=secret",
        ownerHash: "person@example.invalid",
        requestId: "request?id=secret",
        runpodJobId: "runpod/job?token=secret",
        sizeBytes: -1,
        status: "failed with transcript body",
      }),
    ).toEqual({});
  });
});

describe("createStructuredLogger", () => {
  it("writes one deterministic JSON object per record", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      environment: "staging",
      now: () => FIXED_DATE,
      service: "orchestrator",
      sink: (line) => {
        lines.push(line);
      },
    });

    expect(
      logger.info("job.submission_started", {
        attemptId: ATTEMPT_ID,
        jobId: JOB_ID,
        status: "SUBMITTING",
      }),
    ).toEqual({
      attemptId: ATTEMPT_ID,
      environment: "staging",
      event: "job.submission_started",
      jobId: JOB_ID,
      level: "info",
      service: "orchestrator",
      status: "SUBMITTING",
      timestamp: "2026-07-25T00:00:00.000Z",
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      attemptId: ATTEMPT_ID,
      environment: "staging",
      event: "job.submission_started",
      jobId: JOB_ID,
      level: "info",
      service: "orchestrator",
      status: "SUBMITTING",
      timestamp: "2026-07-25T00:00:00.000Z",
    });
  });

  it("allows a fixed Cloud Run identity rejection stage without arbitrary metadata", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      environment: "staging",
      now: () => FIXED_DATE,
      service: "orchestrator",
      sink: (line) => {
        lines.push(line);
      },
    });

    logger.warn("cloud_run_identity_rejected", {
      errorCode: "JWKS_TRANSPORT_REJECTED",
      // @ts-expect-error Exercise the runtime sanitizer with secret-bearing input.
      identityToken: "secret-token",
    });

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      environment: "staging",
      errorCode: "JWKS_TRANSPORT_REJECTED",
      event: "cloud_run_identity_rejected",
      level: "warn",
      service: "orchestrator",
      timestamp: "2026-07-25T00:00:00.000Z",
    });
    expect(lines[0]).not.toContain("secret-token");
  });

  it("never serializes unknown fields passed through a wider object", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      environment: "local",
      now: () => FIXED_DATE,
      service: "web",
      sink: (line) => {
        lines.push(line);
      },
    });
    const contextWithSecrets = {
      accessJwt: "secret-access-jwt",
      jobId: JOB_ID,
      presignedUrl: "https://storage.example.invalid/?signature=secret",
      transcript: "secret transcript body",
    };

    logger.error("job.failed", contextWithSecrets);

    const serialized = lines.join("\n");
    expect(serialized).toContain(JOB_ID);
    expect(serialized).not.toContain("secret-access-jwt");
    expect(serialized).not.toContain("signature=secret");
    expect(serialized).not.toContain("secret transcript body");
  });

  it("replaces an unsafe event name instead of logging its contents", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      environment: "local",
      now: () => FIXED_DATE,
      service: "web",
      sink: (line) => {
        lines.push(line);
      },
    });

    // @ts-expect-error Exercise the runtime boundary used by untyped JavaScript callers.
    logger.warn("secret transcript body https://signed.example", { jobId: JOB_ID });

    expect(lines[0]).toContain('"event":"invalid_log_event"');
    expect(lines[0]).not.toContain("secret transcript body");
    expect(lines[0]).not.toContain("signed.example");
  });
});
