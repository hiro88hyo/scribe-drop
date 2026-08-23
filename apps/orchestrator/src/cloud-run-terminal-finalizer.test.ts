import { describe, expect, it, vi } from "vitest";

import {
  CloudRunTerminalFinalizer,
  type CloudRunTerminalFinalizerDependencies,
} from "./cloud-run-terminal-finalizer.js";
import type { CloudRunTerminalRepository } from "./cloud-run-terminal-repository.js";
import type { RuntimeAttemptContext } from "./cloud-run-runtime-store.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const HANDLE = "h".repeat(43);
const OWNER_HASH = "a".repeat(32);
const context: RuntimeAttemptContext = {
  attemptId: ATTEMPT_ID,
  cancelRequested: false,
  environment: "staging",
  executionHandle: HANDLE,
  jobId: JOB_ID,
  options: {
    contractVersion: 2,
    language: "auto",
    model: "large-v3-turbo",
    outputFormats: ["markdown", "json"],
    vad: true,
  },
  ownerHash: OWNER_HASH,
  sourceEtag: "etag",
  sourceKey: "incoming/source.m4a",
  sourceSizeBytes: 1024,
  status: "TERMINAL_REPORTED",
};
const prefix = `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/`;
const request = {
  artifactCount: 2,
  durationSeconds: 60,
  errorCode: null,
  executionHandle: HANDLE,
  manifestWritten: true,
  segmentCount: 4,
  sequence: 1,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  sessionToken: "s".repeat(43),
  status: "succeeded",
} as const;
const manifest = {
  artifacts: [
    { format: "markdown", key: `${prefix}transcript.md`, sha256: "a".repeat(64), sizeBytes: 10 },
    { format: "json", key: `${prefix}transcript.json`, sha256: "b".repeat(64), sizeBytes: 20 },
  ],
  attemptId: ATTEMPT_ID,
  complete: true,
  detectedLanguage: "en",
  executionContractVersion: 2,
  jobId: JOB_ID,
  requestedLanguage: "auto",
  requestedFormats: ["markdown", "json"],
  schemaVersion: 3,
} as const;

function dependencies(
  repository: CloudRunTerminalRepository,
): CloudRunTerminalFinalizerDependencies {
  return {
    createEventId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    createNotificationId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    createRepository: () => repository,
    now: () => new Date("2026-08-13T00:01:00.000Z"),
    readArtifactSize: (_bucket, key) =>
      Promise.resolve(key.endsWith(".md") ? 10 : key.endsWith(".json") ? 20 : null),
    readManifest: () => Promise.resolve(manifest),
  };
}

describe("Cloud Run terminal finalizer", () => {
  it("verifies the exact option-bound manifest and every selected artifact", async () => {
    const repository: CloudRunTerminalRepository = {
      finalizeFailure: () => Promise.resolve(false),
      finalizeSuccess: () => Promise.resolve(true),
    };
    const finalizeSuccess = vi.spyOn(repository, "finalizeSuccess");
    await expect(
      new CloudRunTerminalFinalizer(
        {} as D1Database,
        {} as R2Bucket,
        dependencies(repository),
      ).finalize({
        context,
        request,
      }),
    ).resolves.toBeUndefined();
    expect(finalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({ manifest }));
  });

  it("does not finalize when an artifact size differs from the signed manifest", async () => {
    const repository: CloudRunTerminalRepository = {
      finalizeFailure: () => Promise.resolve(false),
      finalizeSuccess: () => Promise.resolve(true),
    };
    const selected = dependencies(repository);
    await expect(
      new CloudRunTerminalFinalizer({} as D1Database, {} as R2Bucket, {
        ...selected,
        readArtifactSize: () => Promise.resolve(1),
      }).finalize({ context, request }),
    ).rejects.toThrow("artifact was rejected");
    expect(vi.spyOn(repository, "finalizeSuccess")).not.toHaveBeenCalled();
  });

  it("does not finalize when the manifest language differs from the immutable options", async () => {
    const repository: CloudRunTerminalRepository = {
      finalizeFailure: () => Promise.resolve(false),
      finalizeSuccess: () => Promise.resolve(true),
    };
    await expect(
      new CloudRunTerminalFinalizer(
        {} as D1Database,
        {} as R2Bucket,
        dependencies(repository),
      ).finalize({
        context: { ...context, options: { ...context.options, language: "en" } },
        request,
      }),
    ).rejects.toThrow("manifest was rejected");
  });
});
