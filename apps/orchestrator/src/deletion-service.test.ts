import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type { DeletionCandidate, DeletionRepository } from "./deletion-repository.js";
import { processPendingDeletions, type DeletionEnvironment } from "./deletion-service.js";
import type { RunpodControlClient } from "./runpod-client.js";

const NOW = new Date("2026-07-26T04:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE_KEY = `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.mp3`;
const RESULT_PREFIX = `results/${JOB_ID}/01ARZ3NDEKTSV4RRFFQ69G5FAW/`;

function candidate(overrides: Partial<DeletionCandidate> = {}): DeletionCandidate {
  return {
    deletionAttemptCount: 0,
    deletionNotBefore: "2026-07-26T03:59:00.000Z",
    jobId: JOB_ID,
    sourceKey: SOURCE_KEY,
    version: 3,
    ...overrides,
  };
}

function fakeRepository(
  deletionCandidate: DeletionCandidate,
  overrides: Partial<DeletionRepository> = {},
): DeletionRepository {
  return {
    assertProviderCompatibility: () => Promise.resolve(),
    deferDeletion: () => Promise.resolve(true),
    deleteJobRecord: () => Promise.resolve("deleted"),
    findDeletionCandidates: () => Promise.resolve([deletionCandidate]),
    findResultPrefixes: () =>
      Promise.resolve({
        nextGeneration: null,
        prefixes: [RESULT_PREFIX],
      }),
    findRunpodJobIds: () =>
      Promise.resolve({
        jobIds: ["runpod-job-placeholder"],
        nextCursor: null,
      }),
    recordDeletionRetry: () => Promise.resolve(true),
    ...overrides,
  };
}

function environment(bucket: R2Bucket): DeletionEnvironment {
  return {
    RECORDINGS: bucket,
    RUNPOD_API_KEY: "runpod-api-key-placeholder",
    RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
    SCRIBE_DROP_DB: {} as D1Database,
  };
}

function logger(records: string[]): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: (record) => {
      records.push(record);
    },
  });
}

function memoryBucket(
  initialKeys: readonly string[],
  overrides: {
    readonly failDelete?: boolean;
  } = {},
): {
  readonly bucket: R2Bucket;
  readonly keys: Set<string>;
} {
  const keys = new Set(initialKeys);
  const bucket = {
    delete: (keyOrKeys: string | string[]) => {
      if (overrides.failDelete === true) {
        return Promise.reject(new Error("simulated R2 failure"));
      }
      const requestedKeys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const key of requestedKeys) {
        keys.delete(key);
      }
      return Promise.resolve();
    },
    head: (key: string) => Promise.resolve(keys.has(key) ? ({ key } as unknown as R2Object) : null),
    list: (options: R2ListOptions) =>
      Promise.resolve({
        delimitedPrefixes: [],
        objects: [...keys]
          .filter((key) => key.startsWith(options.prefix ?? ""))
          .slice(0, options.limit)
          .map((key) => ({ key })),
        truncated: false,
      }),
  } as unknown as R2Bucket;
  return { bucket, keys };
}

function runpodClient(
  cancel: RunpodControlClient["cancel"] = () => Promise.resolve({ outcome: "accepted" }),
): RunpodControlClient {
  return {
    cancel,
    getStatus: () => Promise.resolve({ outcome: "not_found" }),
  };
}

describe("pending user deletion sweep", () => {
  it("cancels known RunPod work and waits for issued capabilities to expire", async () => {
    const waitingCandidate = candidate({
      deletionNotBefore: "2026-07-26T05:00:00.000Z",
    });
    const deferDeletion = vi.fn<DeletionRepository["deferDeletion"]>(() => Promise.resolve(true));
    const cancel = vi.fn<RunpodControlClient["cancel"]>(() =>
      Promise.resolve({ outcome: "accepted" }),
    );
    const records: string[] = [];

    await expect(
      processPendingDeletions(environment(memoryBucket([]).bucket), logger(records), {
        createRepository: () => fakeRepository(waitingCandidate, { deferDeletion }),
        createRunpodClient: () => runpodClient(cancel),
        now: () => NOW,
      }),
    ).resolves.toEqual({
      completedCount: 0,
      deferredCount: 1,
      retryCount: 0,
    });

    expect(cancel).toHaveBeenCalledWith("runpod-job-placeholder");
    expect(deferDeletion).toHaveBeenCalledWith({
      expectedVersion: 3,
      jobId: JOB_ID,
      nextAttemptAt: "2026-07-26T05:00:00.000Z",
      timestamp: NOW.toISOString(),
    });
    expect(records.join("\n")).toContain('"event":"job.deletion_deferred"');
  });

  it("backs off with jitter when RunPod cancellation is not confirmed", async () => {
    const waitingCandidate = candidate({
      deletionAttemptCount: 1,
      deletionNotBefore: "2026-07-26T05:00:00.000Z",
    });
    const recordDeletionRetry = vi.fn<DeletionRepository["recordDeletionRetry"]>(() =>
      Promise.resolve(true),
    );

    await expect(
      processPendingDeletions(environment(memoryBucket([]).bucket), logger([]), {
        createRepository: () =>
          fakeRepository(waitingCandidate, {
            recordDeletionRetry,
          }),
        createRunpodClient: () => runpodClient(() => Promise.resolve({ outcome: "unavailable" })),
        now: () => NOW,
        random: () => 0.5,
      }),
    ).resolves.toEqual({
      completedCount: 0,
      deferredCount: 0,
      retryCount: 1,
    });

    expect(recordDeletionRetry).toHaveBeenCalledWith({
      errorCode: "RUNPOD_CANCEL_FAILED",
      expectedVersion: 3,
      jobId: JOB_ID,
      nextAttemptAt: "2026-07-26T04:01:00.000Z",
      timestamp: NOW.toISOString(),
    });
  });

  it("does not contact RunPod when provider execution state drifted", async () => {
    const cancel = vi.fn<RunpodControlClient["cancel"]>();
    const recordDeletionRetry = vi.fn<DeletionRepository["recordDeletionRetry"]>(() =>
      Promise.resolve(true),
    );

    await expect(
      processPendingDeletions(environment(memoryBucket([]).bucket), logger([]), {
        createRepository: () =>
          fakeRepository(candidate(), {
            assertProviderCompatibility: () =>
              Promise.reject(new Error("provider execution drift")),
            recordDeletionRetry,
          }),
        createRunpodClient: () => runpodClient(cancel),
        now: () => NOW,
        random: () => 0.5,
      }),
    ).resolves.toEqual({
      completedCount: 0,
      deferredCount: 0,
      retryCount: 1,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(recordDeletionRetry).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "RUNPOD_CANCEL_FAILED", jobId: JOB_ID }),
    );
  });

  it("cancels known RunPod work before deleting an already-expired job record", async () => {
    const order: string[] = [];
    const cancel = vi.fn<RunpodControlClient["cancel"]>(() => {
      order.push("cancel");
      return Promise.resolve({ outcome: "accepted" });
    });
    const deleteJobRecord = vi.fn<DeletionRepository["deleteJobRecord"]>(() => {
      order.push("delete");
      return Promise.resolve("deleted");
    });

    await expect(
      processPendingDeletions(environment(memoryBucket([]).bucket), logger([]), {
        createRepository: () => fakeRepository(candidate(), { deleteJobRecord }),
        createRunpodClient: () => runpodClient(cancel),
        now: () => NOW,
      }),
    ).resolves.toEqual({
      completedCount: 1,
      deferredCount: 0,
      retryCount: 0,
    });

    expect(cancel).toHaveBeenCalledWith("runpod-job-placeholder");
    expect(order).toEqual(["cancel", "delete"]);
  });

  it("removes the exact source and every attempt prefix before deleting D1", async () => {
    const unrelatedKey = "results/unrelated/object.txt";
    const { bucket, keys } = memoryBucket([
      SOURCE_KEY,
      `${RESULT_PREFIX}partial.json`,
      `${RESULT_PREFIX}transcript.md`,
      unrelatedKey,
    ]);
    const deleteJobRecord = vi.fn<DeletionRepository["deleteJobRecord"]>(() =>
      Promise.resolve("deleted"),
    );

    await expect(
      processPendingDeletions(environment(bucket), logger([]), {
        createRepository: () => fakeRepository(candidate(), { deleteJobRecord }),
        createRunpodClient: () => runpodClient(),
        now: () => NOW,
      }),
    ).resolves.toEqual({
      completedCount: 1,
      deferredCount: 0,
      retryCount: 0,
    });

    expect(keys).toEqual(new Set([unrelatedKey]));
    expect(deleteJobRecord).toHaveBeenCalledWith({
      expectedVersion: 3,
      jobId: JOB_ID,
      timestamp: NOW.toISOString(),
    });
  });

  it("keeps D1 and records a bounded retry when R2 deletion fails", async () => {
    const { bucket } = memoryBucket([SOURCE_KEY], { failDelete: true });
    const deleteJobRecord = vi.fn<DeletionRepository["deleteJobRecord"]>();
    const recordDeletionRetry = vi.fn<DeletionRepository["recordDeletionRetry"]>(() =>
      Promise.resolve(true),
    );

    await expect(
      processPendingDeletions(environment(bucket), logger([]), {
        createRepository: () =>
          fakeRepository(candidate(), {
            deleteJobRecord,
            recordDeletionRetry,
          }),
        createRunpodClient: () => runpodClient(),
        now: () => NOW,
        random: () => 0.5,
      }),
    ).resolves.toEqual({
      completedCount: 0,
      deferredCount: 0,
      retryCount: 1,
    });

    expect(deleteJobRecord).not.toHaveBeenCalled();
    expect(recordDeletionRetry).toHaveBeenCalledWith({
      errorCode: "R2_DELETE_FAILED",
      expectedVersion: 3,
      jobId: JOB_ID,
      nextAttemptAt: "2026-07-26T04:00:30.000Z",
      timestamp: NOW.toISOString(),
    });
  });
});
