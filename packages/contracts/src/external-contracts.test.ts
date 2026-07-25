import { describe, expect, it } from "vitest";

import {
  MAX_FILE_SIZE_BYTES,
  RUNPOD_MAX_POLICY_DURATION_MS,
  normalizedR2ObjectCreatedEventSchema,
  resultManifestSchema,
  runpodClaimRequestSchema,
  runpodRunRequestSchema,
  runpodStatusResponseSchema,
  type RunpodRunRequest,
} from "./index.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TOKEN = "t".repeat(32);

const validRunpodRequest = {
  input: {
    attempt_id: ATTEMPT_ID,
    claim: {
      token: TOKEN,
      url: "https://hooks.transcribe.example.com/internal/runpod/claim",
    },
    heartbeat: {
      token: TOKEN,
      url: "https://hooks.transcribe.example.com/internal/runpod/heartbeat",
    },
    job_id: JOB_ID,
    options: {
      beam_size: 5,
      language: "ja",
      model: "large-v3-turbo",
      vad: true,
      word_timestamps: false,
    },
    results: {
      json_put_url: "https://storage.example.com/results/transcript.json?signature=redacted",
      manifest_put_url: "https://storage.example.com/results/manifest.json?signature=redacted",
      markdown_put_url: "https://storage.example.com/results/transcript.md?signature=redacted",
      srt_put_url: "https://storage.example.com/results/transcript.srt?signature=redacted",
    },
    schema_version: 1,
    source: {
      expected_etag: "etag",
      expected_size_bytes: MAX_FILE_SIZE_BYTES,
      url: "https://storage.example.com/incoming/source.m4a?signature=redacted",
    },
  },
  policy: {
    executionTimeout: 21_600_000,
    lowPriority: false,
    ttl: 86_400_000,
  },
  webhook: "https://hooks.transcribe.example.com/internal/runpod/webhook/redacted",
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

describe("RunPod schemas", () => {
  it("accepts the pinned worker input and policy", () => {
    expect(runpodRunRequestSchema.safeParse(validRunpodRequest).success).toBe(true);
  });

  it.each([
    [
      "non-HTTPS source",
      {
        ...validRunpodRequest,
        input: {
          ...validRunpodRequest.input,
          source: {
            ...validRunpodRequest.input.source,
            url: "http://storage.example.com/source.m4a",
          },
        },
      },
    ],
    [
      "execution timeout beyond TTL",
      {
        ...validRunpodRequest,
        policy: {
          ...validRunpodRequest.policy,
          executionTimeout: 86_400_001,
        },
      },
    ],
    [
      "policy beyond RunPod maximum",
      {
        ...validRunpodRequest,
        policy: {
          ...validRunpodRequest.policy,
          ttl: RUNPOD_MAX_POLICY_DURATION_MS + 1,
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
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
        token: "short",
      }).success,
    ).toBe(false);
  });

  it("accepts documented RunPod terminal status metadata", () => {
    expect(
      runpodStatusResponseSchema.safeParse({
        delayTime: 31_618,
        executionTime: 1_437,
        id: "runpod-job-id",
        output: {
          attemptId: ATTEMPT_ID,
          complete: true,
          jobId: JOB_ID,
          manifestKey: `results/owner/${JOB_ID}/${ATTEMPT_ID}/manifest.json`,
          schemaVersion: 1,
        },
        status: "COMPLETED",
        workerId: "worker-id",
      }).success,
    ).toBe(true);
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
