import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type { RetentionRepository } from "./retention-repository.js";
import { processRetention, type RetentionEnvironment } from "./retention-service.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const SOURCE_KEY = `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.mp3`;
const RESULT_PREFIX = `results/0123456789abcdef0123456789abcdef/${JOB_ID}/${ATTEMPT_ID}/`;

function environment(bucket: R2Bucket): RetentionEnvironment {
  return {
    AUDIT_RETENTION_DAYS: "180",
    MULTIPART_RETENTION_HOURS: "24",
    RECORDINGS: bucket,
    RESULT_RETENTION_DAYS: "90",
    SCRIBE_DROP_DB: {} as D1Database,
    SOURCE_RETENTION_DAYS: "7",
  };
}

function fakeRepository(overrides: Partial<RetentionRepository> = {}): RetentionRepository {
  return {
    findAuditRetentionCandidates: () => Promise.resolve([]),
    findResultRetentionCandidates: () => Promise.resolve([]),
    findSourceRetentionCandidates: () => Promise.resolve([]),
    markAuditRetentionExpired: () => Promise.resolve(false),
    markResultsDeleted: () => Promise.resolve(false),
    markSourceDeleted: () => Promise.resolve(false),
    ...overrides,
  };
}

function logger(records: string[] = []): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: (record) => {
      records.push(record);
    },
  });
}

function memoryBucket(initialKeys: readonly string[]): {
  readonly bucket: R2Bucket;
  readonly keys: Set<string>;
} {
  const keys = new Set(initialKeys);
  return {
    bucket: {
      delete: (keyOrKeys: string | string[]) => {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
          keys.delete(key);
        }
        return Promise.resolve();
      },
      head: (key: string) =>
        Promise.resolve(keys.has(key) ? ({ key } as unknown as R2Object) : null),
      list: (options: R2ListOptions) =>
        Promise.resolve({
          delimitedPrefixes: [],
          objects: [...keys]
            .filter((key) => key.startsWith(options.prefix ?? ""))
            .map((key) => ({ key })),
          truncated: false,
        }),
    } as unknown as R2Bucket,
    keys,
  };
}

describe("retention sweep", () => {
  it("expires source, result prefixes, and audit metadata at separate cutoffs", async () => {
    const unrelatedKey = "results/unrelated/keep.txt";
    const { bucket, keys } = memoryBucket([
      SOURCE_KEY,
      `${RESULT_PREFIX}partial.json`,
      unrelatedKey,
    ]);
    const findSourceRetentionCandidates = vi.fn<
      RetentionRepository["findSourceRetentionCandidates"]
    >(() =>
      Promise.resolve([
        {
          jobId: JOB_ID,
          sourceKey: SOURCE_KEY,
          version: 2,
        },
      ]),
    );
    const findResultRetentionCandidates = vi.fn<
      RetentionRepository["findResultRetentionCandidates"]
    >(() =>
      Promise.resolve([
        {
          attemptId: ATTEMPT_ID,
          attemptStatus: "COMPLETED",
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          jobId: JOB_ID,
          resultPrefix: RESULT_PREFIX,
        },
      ]),
    );
    const findAuditRetentionCandidates = vi.fn<RetentionRepository["findAuditRetentionCandidates"]>(
      () =>
        Promise.resolve([
          {
            jobId: JOB_ID,
            latestCapabilityIssuedAt: null,
            version: 4,
          },
        ]),
    );
    const markSourceDeleted = vi.fn<RetentionRepository["markSourceDeleted"]>(() =>
      Promise.resolve(true),
    );
    const markResultsDeleted = vi.fn<RetentionRepository["markResultsDeleted"]>(() =>
      Promise.resolve(true),
    );
    const markAuditRetentionExpired = vi.fn<RetentionRepository["markAuditRetentionExpired"]>(() =>
      Promise.resolve(true),
    );

    await expect(
      processRetention(environment(bucket), logger(), {
        createEventId: () => EVENT_ID,
        createRepository: () =>
          fakeRepository({
            findAuditRetentionCandidates,
            findResultRetentionCandidates,
            findSourceRetentionCandidates,
            markAuditRetentionExpired,
            markResultsDeleted,
            markSourceDeleted,
          }),
        now: () => NOW,
      }),
    ).resolves.toEqual({
      auditScheduledCount: 1,
      resultDeletedCount: 1,
      retryCount: 0,
      sourceDeletedCount: 1,
    });

    expect(keys).toEqual(new Set([unrelatedKey]));
    expect(findSourceRetentionCandidates).toHaveBeenCalledWith("2026-12-25T00:00:00.000Z", 25);
    expect(findResultRetentionCandidates).toHaveBeenCalledWith("2026-10-03T00:00:00.000Z", 25);
    expect(findAuditRetentionCandidates).toHaveBeenCalledWith("2026-07-05T00:00:00.000Z", 25);
    expect(markAuditRetentionExpired).toHaveBeenCalledWith({
      cutoff: "2026-07-05T00:00:00.000Z",
      eventId: EVENT_ID,
      expectedVersion: 4,
      jobId: JOB_ID,
      latestCapabilityIssuedAt: null,
      timestamp: NOW.toISOString(),
    });
  });

  it("retries an R2 failure without marking the source deleted", async () => {
    const markSourceDeleted = vi.fn<RetentionRepository["markSourceDeleted"]>();
    const records: string[] = [];
    const bucket = {
      delete: () => Promise.reject(new Error("simulated R2 failure")),
    } as unknown as R2Bucket;

    await expect(
      processRetention(environment(bucket), logger(records), {
        createRepository: () =>
          fakeRepository({
            findSourceRetentionCandidates: () =>
              Promise.resolve([
                {
                  jobId: JOB_ID,
                  sourceKey: SOURCE_KEY,
                  version: 2,
                },
              ]),
            markSourceDeleted,
          }),
        now: () => NOW,
      }),
    ).resolves.toEqual({
      auditScheduledCount: 0,
      resultDeletedCount: 0,
      retryCount: 1,
      sourceDeletedCount: 0,
    });

    expect(markSourceDeleted).not.toHaveBeenCalled();
    expect(records.join("\n")).toContain('"event":"retention.retry"');
    expect(records.join("\n")).not.toContain("simulated R2 failure");
  });

  it("fails closed before D1 when retention configuration is invalid", async () => {
    const createRepository = vi.fn();

    await expect(
      processRetention(
        {
          ...environment(memoryBucket([]).bucket),
          SOURCE_RETENTION_DAYS: "91",
        },
        logger(),
        { createRepository },
      ),
    ).rejects.toThrow("Retention configuration is invalid");

    expect(createRepository).not.toHaveBeenCalled();
  });
});
