import { describe, expect, it } from "vitest";

import {
  normalizedR2ObjectCreatedEventSchema,
  r2EventNotificationSchema,
  resultManifestSchema,
  runpodClaimRequestSchema,
  runpodClaimResponseSchema,
  runpodPlacementStatusResponseSchema,
  runpodRunRequestSchema,
  runpodStatusResponseSchema,
  type RunpodRunRequest,
} from "./index.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TOKEN = "t".repeat(43);

const validRunpodRequest = {
  input: {
    attemptId: ATTEMPT_ID,
    claimToken: TOKEN,
    jobId: JOB_ID,
    schemaVersion: 1,
  },
  policy: {
    executionTimeout: 21_600_000,
    ttl: 28_800_000,
  },
} satisfies RunpodRunRequest;

describe("normalizedR2ObjectCreatedEventSchema", () => {
  const validEvent = {
    bucket: "recording-transcriber-staging",
    etag: "etag",
    eventType: "object-create",
    jobId: JOB_ID,
    key: `incoming/owner-hash/${JOB_ID}/nonce/source.m4a`,
    occurredAt: "2026-07-25T00:00:00.000Z",
    sizeBytes: 1024,
  };

  it("accepts a normalized incoming-object event", () => {
    expect(normalizedR2ObjectCreatedEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("rejects a job ID that does not match the object key", () => {
    expect(
      normalizedR2ObjectCreatedEventSchema.safeParse({
        ...validEvent,
        jobId: ATTEMPT_ID,
      }).success,
    ).toBe(false);
  });
});

describe("r2EventNotificationSchema", () => {
  const validEvent = {
    account: "0123456789abcdef0123456789abcdef",
    action: "CompleteMultipartUpload",
    bucket: "recording-transcriber-staging",
    eventTime: "2026-07-25T00:00:00.000Z",
    object: {
      eTag: "multipart-etag",
      key: `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.m4a`,
      size: 1024,
    },
  };

  it("accepts the documented CompleteMultipartUpload notification", () => {
    expect(r2EventNotificationSchema.safeParse(validEvent).success).toBe(true);
  });

  it.each([
    ["unknown action", { ...validEvent, action: "UnknownAction" }],
    ["unknown field", { ...validEvent, token: "must-not-be-retained" }],
    [
      "copy without source",
      {
        ...validEvent,
        action: "CopyObject",
      },
    ],
    [
      "non-copy with source",
      {
        ...validEvent,
        copySource: {
          bucket: validEvent.bucket,
          object: "original",
        },
      },
    ],
  ])("rejects %s", (_caseName, event) => {
    expect(r2EventNotificationSchema.safeParse(event).success).toBe(false);
  });
});

describe("RunPod schemas", () => {
  it("accepts the pinned worker input and policy", () => {
    expect(runpodRunRequestSchema.safeParse(validRunpodRequest).success).toBe(true);
  });

  it.each([
    [
      "presigned source URL",
      {
        ...validRunpodRequest,
        input: {
          ...validRunpodRequest.input,
          source: { getUrl: "https://storage.example.invalid/source?signature=redacted" },
        },
      },
    ],
    [
      "unpinned execution timeout",
      {
        ...validRunpodRequest,
        policy: {
          ...validRunpodRequest.policy,
          executionTimeout: 21_600_001,
        },
      },
    ],
    [
      "webhook",
      {
        ...validRunpodRequest,
        webhook: "https://hooks.example.invalid/internal/runpod/webhook",
      },
    ],
    [
      "s3 credentials",
      {
        ...validRunpodRequest,
        s3Config: {
          accessId: "must-not-be-accepted",
          accessSecret: "must-not-be-accepted",
          bucketName: "must-not-be-accepted",
          endpointUrl: "https://storage.example.invalid",
        },
      },
    ],
    [
      "unknown input field",
      {
        ...validRunpodRequest,
        input: {
          ...validRunpodRequest.input,
          accessKey: "must-not-be-accepted",
        },
      },
    ],
  ])("rejects %s", (_caseName, request) => {
    expect(runpodRunRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects short claim tokens", () => {
    expect(
      runpodClaimRequestSchema.safeParse({
        attemptId: ATTEMPT_ID,
        claimToken: "short",
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      }).success,
    ).toBe(false);
  });

  it("accepts capability details only in a successful claim response", () => {
    expect(
      runpodClaimResponseSchema.safeParse({
        expiresAt: "2026-07-25T02:00:00.000Z",
        granted: true,
        heartbeat: {
          token: TOKEN,
          url: "https://orchestrator.example.invalid/internal/runpod/heartbeat",
        },
        results: {
          jsonPutUrl: "https://storage.example.invalid/transcript.json?signature=redacted",
          manifestPutUrl: "https://storage.example.invalid/manifest.json?signature=redacted",
          markdownPutUrl: "https://storage.example.invalid/transcript.md?signature=redacted",
          srtPutUrl: "https://storage.example.invalid/transcript.srt?signature=redacted",
        },
        source: {
          expectedEtag: "etag",
          expectedSizeBytes: 1024,
          getUrl: "https://storage.example.invalid/source?signature=redacted",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts documented RunPod terminal status metadata", () => {
    expect(
      runpodStatusResponseSchema.safeParse({
        delayTime: 31_618,
        executionTime: 1_437,
        id: "runpod-job-id",
        output: {
          attemptId: ATTEMPT_ID,
          detectedLanguage: "ja",
          durationSeconds: 123.5,
          jobId: JOB_ID,
          manifestWritten: true,
          schemaVersion: 1,
          segmentCount: 42,
          status: "completed",
        },
        status: "COMPLETED",
        workerId: "worker-id",
      }).success,
    ).toBe(true);
  });

  it("validates and discards unneeded provider metadata echoed by RunPod status", () => {
    const result = runpodStatusResponseSchema.safeParse({
      delayTime: 1_000,
      error: "provider detail that must not reach logs",
      id: "runpod-job-id",
      input: {
        attemptId: ATTEMPT_ID,
        claimToken: "A".repeat(43),
        jobId: JOB_ID,
        schemaVersion: 1,
      },
      status: "IN_PROGRESS",
      workerId: "worker-id",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect("error" in result.data).toBe(false);
      expect("input" in result.data).toBe(false);
      expect("workerId" in result.data).toBe(false);
    }
  });

  it("retains only the provider worker binding needed for placement attestation", () => {
    const result = runpodPlacementStatusResponseSchema.safeParse({
      id: "runpod-job-id",
      input: {
        attemptId: ATTEMPT_ID,
        claimToken: "A".repeat(43),
        jobId: JOB_ID,
        schemaVersion: 1,
      },
      status: "IN_PROGRESS",
      workerId: "worker-id",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        id: "runpod-job-id",
        status: "IN_PROGRESS",
        workerId: "worker-id",
      });
      expect("input" in result.data).toBe(false);
    }
  });
});

describe("resultManifestSchema", () => {
  const artifact = {
    key: `results/owner/${JOB_ID}/${ATTEMPT_ID}/transcript.md`,
    sha256: "a".repeat(64),
    sizeBytes: 1234,
  };
  const validManifest = {
    artifacts: {
      json: { ...artifact, key: artifact.key.replace(".md", ".json") },
      markdown: artifact,
      srt: { ...artifact, key: artifact.key.replace(".md", ".srt") },
    },
    attemptId: ATTEMPT_ID,
    complete: true,
    jobId: JOB_ID,
    schemaVersion: 1,
  };

  it("accepts a complete manifest with all artifacts", () => {
    expect(resultManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it.each([
    ["incomplete manifest", { ...validManifest, complete: false }],
    [
      "invalid checksum",
      {
        ...validManifest,
        artifacts: {
          ...validManifest.artifacts,
          markdown: {
            ...validManifest.artifacts.markdown,
            sha256: "not-a-checksum",
          },
        },
      },
    ],
    ["unknown field", { ...validManifest, sourceUrl: "https://must-not-be-retained.example" }],
  ])("rejects %s", (_caseName, manifest) => {
    expect(resultManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
