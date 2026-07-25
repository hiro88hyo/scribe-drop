import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it } from "vitest";

import { parseSourceObjectKey } from "./source-object-key.js";
import {
  handleUploadQueueBatch,
  type UploadQueueEnvironment,
  type UploadQueueMessage,
} from "./upload-queue-consumer.js";
import type {
  IngestSourceInput,
  SourceJob,
  UploadIngestionRepository,
} from "./upload-ingestion-repository.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OWNER_HASH = "0123456789abcdef0123456789abcdef";
const SOURCE_KEY = `incoming/${OWNER_HASH}/${JOB_ID}/ABCDEFGHIJKLMNOPQRSTUV/source.m4a`;
const EVENT = {
  account: "0123456789abcdef0123456789abcdef",
  action: "CompleteMultipartUpload",
  bucket: "recording-transcriber-test",
  eventTime: NOW.toISOString(),
  object: {
    eTag: "multipart-etag",
    key: SOURCE_KEY,
    size: 1024,
  },
} as const;
const JOB = {
  activeAttemptId: null,
  actualSizeBytes: null,
  expectedSizeBytes: 1024,
  generationOneAttemptId: null,
  id: JOB_ID,
  sourceBucket: EVENT.bucket,
  sourceEtag: null,
  sourceKey: SOURCE_KEY,
  status: "UPLOADING",
  version: 2,
} satisfies SourceJob;

class FakeMessage implements UploadQueueMessage {
  readonly attempts: number;
  readonly body: unknown;
  acknowledgements = 0;
  retryDelays: number[] = [];

  constructor(body: unknown, attempts = 1) {
    this.attempts = attempts;
    this.body = body;
  }

  ack(): void {
    this.acknowledgements += 1;
  }

  retry(options: { readonly delaySeconds: number }): void {
    this.retryDelays.push(options.delaySeconds);
  }
}

function environment(): UploadQueueEnvironment {
  return {
    APP_ENV: "local",
    CLOUDFLARE_ACCOUNT_ID: EVENT.account,
    // These bindings are never invoked because every unit test injects its ports.
    RECORDINGS: {} as R2Bucket,
    R2_BUCKET_NAME: EVENT.bucket,
    SCRIBE_DROP_DB: {} as D1Database,
  };
}

function fakeRepository(
  overrides: Partial<UploadIngestionRepository> = {},
): UploadIngestionRepository {
  return {
    failSource: () => Promise.resolve(true),
    findSourceJob: () => Promise.resolve(JOB),
    ingestSource: () => Promise.resolve("ingested"),
    markSourceMutated: () => Promise.resolve(true),
    ...overrides,
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

describe("source object key boundary", () => {
  it("accepts only the generated incoming key shape", () => {
    expect(parseSourceObjectKey(SOURCE_KEY)).toEqual({
      jobId: JOB_ID,
      ownerHash: OWNER_HASH,
    });
    expect(
      parseSourceObjectKey(`incoming/${OWNER_HASH}/${JOB_ID}/short/source.m4a`),
    ).toBeUndefined();
    expect(
      parseSourceObjectKey(`incoming/${OWNER_HASH}/${JOB_ID}/ABCDEFGHIJKLMNOPQRSTUV/../../secret`),
    ).toBeUndefined();
  });
});

describe("R2 upload Queue consumer", () => {
  it("revalidates HEAD, creates one pending attempt, and acknowledges the message", async () => {
    const message = new FakeMessage(EVENT);
    const records: string[] = [];
    let ingestion: IngestSourceInput | undefined;
    const repository = fakeRepository({
      ingestSource: (input) => {
        ingestion = input;
        return Promise.resolve("ingested");
      },
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createAttemptId: () => ATTEMPT_ID,
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: EVENT.object.eTag,
          size: EVENT.object.size,
        }),
      logger: logger(records),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(message.retryDelays).toEqual([]);
    expect(ingestion).toMatchObject({
      attemptId: ATTEMPT_ID,
      eventId: EVENT_ID,
      job: JOB,
      ownerHash: OWNER_HASH,
      sizeBytes: 1024,
      sourceEtag: "multipart-etag",
    });
    expect(ingestion?.claimSentinelHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(ingestion?.heartbeatSentinelHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(ingestion?.webhookSentinelHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      new Set([
        ingestion?.claimSentinelHash,
        ingestion?.heartbeatSentinelHash,
        ingestion?.webhookSentinelHash,
      ]).size,
    ).toBe(3);
    expect(records.join("\n")).not.toContain(SOURCE_KEY);
    expect(records.join("\n")).not.toContain(EVENT.object.eTag);
  });

  it("acknowledges malformed messages without touching D1 or retaining raw fields", async () => {
    const message = new FakeMessage({
      ...EVENT,
      sessionToken: "must-not-be-retained",
    });
    const records: string[] = [];
    let repositoryCreations = 0;

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createRepository: () => {
        repositoryCreations += 1;
        return fakeRepository();
      },
      logger: logger(records),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(message.retryDelays).toEqual([]);
    expect(repositoryCreations).toBe(0);
    expect(records.join("\n")).not.toContain("must-not-be-retained");
  });

  it("isolates dependency failure to one message and applies jittered retry delay", async () => {
    const failed = new FakeMessage(EVENT, 2);
    const malformed = new FakeMessage({ malformed: true });
    const records: string[] = [];
    const repository = fakeRepository({
      findSourceJob: () => Promise.reject(new Error("raw-database-detail")),
    });

    await handleUploadQueueBatch({ messages: [failed, malformed] }, environment(), {
      createRepository: () => repository,
      logger: logger(records),
      now: () => NOW,
      random: () => 0.5,
    });

    expect(failed.acknowledgements).toBe(0);
    expect(failed.retryDelays).toEqual([16]);
    expect(malformed.acknowledgements).toBe(1);
    expect(malformed.retryDelays).toEqual([]);
    expect(records.join("\n")).not.toContain("raw-database-detail");
  });

  it("acknowledges a stale event without creating an attempt", async () => {
    const message = new FakeMessage(EVENT);
    let ingestionCalls = 0;
    const repository = fakeRepository({
      ingestSource: () => {
        ingestionCalls += 1;
        return Promise.resolve("ingested");
      },
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: "newer-etag",
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(ingestionCalls).toBe(0);
  });

  it("marks an established source as mutated and acknowledges the event", async () => {
    const message = new FakeMessage({
      ...EVENT,
      object: {
        ...EVENT.object,
        eTag: "replacement-etag",
      },
    });
    let observedEtag: string | undefined;
    const repository = fakeRepository({
      findSourceJob: () =>
        Promise.resolve({
          ...JOB,
          sourceEtag: "original-etag",
          status: "SUBMISSION_PENDING",
        }),
      markSourceMutated: (_job, etag) => {
        observedEtag = etag;
        return Promise.resolve(true);
      },
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: "replacement-etag",
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(observedEtag).toBe("replacement-etag");
  });

  it("fails exact-key uploads created through a disallowed R2 action", async () => {
    const message = new FakeMessage({
      ...EVENT,
      action: "PutObject",
    });
    let failureCode: string | undefined;
    const repository = fakeRepository({
      failSource: (_job, errorCode) => {
        failureCode = errorCode;
        return Promise.resolve(true);
      },
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: EVENT.object.eTag,
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(failureCode).toBe("PROCESSING_FAILED");
  });

  it("acknowledges a disallowed action that arrives after source ingestion", async () => {
    const message = new FakeMessage({
      ...EVENT,
      action: "PutObject",
    });
    let failureCalls = 0;
    const ingestedJob = {
      ...JOB,
      activeAttemptId: ATTEMPT_ID,
      actualSizeBytes: EVENT.object.size,
      generationOneAttemptId: ATTEMPT_ID,
      sourceEtag: EVENT.object.eTag,
      status: "SUBMISSION_PENDING",
    } satisfies SourceJob;
    const repository = fakeRepository({
      failSource: () => {
        failureCalls += 1;
        return Promise.resolve(false);
      },
      findSourceJob: () => Promise.resolve(ingestedJob),
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: EVENT.object.eTag,
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(message.retryDelays).toEqual([]);
    expect(failureCalls).toBe(1);
  });

  it("acknowledges an event ignored after a concurrent terminal transition", async () => {
    const message = new FakeMessage(EVENT);
    const repository = fakeRepository({
      ingestSource: () => Promise.resolve("ignored"),
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createAttemptId: () => ATTEMPT_ID,
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: EVENT.object.eTag,
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
    });

    expect(message.acknowledgements).toBe(1);
    expect(message.retryDelays).toEqual([]);
  });

  it("retries a compare-and-set conflict instead of acknowledging it", async () => {
    const message = new FakeMessage(EVENT);
    const repository = fakeRepository({
      ingestSource: () => Promise.resolve("conflict"),
    });

    await handleUploadQueueBatch({ messages: [message] }, environment(), {
      createAttemptId: () => ATTEMPT_ID,
      createEventId: () => EVENT_ID,
      createRepository: () => repository,
      headSourceObject: () =>
        Promise.resolve({
          etag: EVENT.object.eTag,
          size: EVENT.object.size,
        }),
      logger: logger([]),
      now: () => NOW,
      random: () => 0,
    });

    expect(message.acknowledgements).toBe(0);
    expect(message.retryDelays).toEqual([1]);
  });
});
