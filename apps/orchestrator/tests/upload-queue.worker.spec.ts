import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { R2EventNotification } from "@scribe-drop/contracts";

import { handleUploadQueueBatch, type UploadQueueMessage } from "../src/upload-queue-consumer.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OWNER_HASH = "0123456789abcdef0123456789abcdef";
const SOURCE_KEY = `incoming/${OWNER_HASH}/${JOB_ID}/ABCDEFGHIJKLMNOPQRSTUV/source.m4a`;

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

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
  const objects = await env.RECORDINGS.list();
  await Promise.all(objects.objects.map((object) => env.RECORDINGS.delete(object.key)));
});

async function insertJob(input?: {
  readonly actualSizeBytes?: number;
  readonly sourceEtag?: string;
  readonly status?: "UPLOADED" | "UPLOADING";
  readonly version?: number;
}): Promise<void> {
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO jobs (
        id,
        owner_sub,
        owner_email,
        title,
        original_filename,
        source_bucket,
        source_key,
        source_content_type,
        expected_size_bytes,
        actual_size_bytes,
        source_etag,
        status,
        options_json,
        version,
        created_at,
        uploaded_at,
        updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?15
      )
    `,
  )
    .bind(
      JOB_ID,
      "owner-sub",
      "owner@example.invalid",
      "Queue integration",
      "recording.m4a",
      env.R2_BUCKET_NAME,
      SOURCE_KEY,
      "audio/mp4",
      1024,
      input?.actualSizeBytes ?? null,
      input?.sourceEtag ?? null,
      input?.status ?? "UPLOADING",
      JSON.stringify({
        language: "ja",
        model: "large-v3-turbo",
        outputFormats: ["markdown", "json", "srt"],
        vad: true,
      }),
      input?.version ?? 2,
      NOW.toISOString(),
      input?.status === "UPLOADED" ? NOW.toISOString() : null,
    )
    .run();
}

function event(etag: string, size = 1024): R2EventNotification {
  return {
    account: env.CLOUDFLARE_ACCOUNT_ID,
    action: "CompleteMultipartUpload",
    bucket: env.R2_BUCKET_NAME,
    eventTime: NOW.toISOString(),
    object: {
      eTag: etag,
      key: SOURCE_KEY,
      size,
    },
  };
}

async function process(message: FakeMessage): Promise<void> {
  await handleUploadQueueBatch({ messages: [message] }, env, {
    createAttemptId: () => ATTEMPT_ID,
    createEventId: () => EVENT_ID,
    logger: {
      debug: () => ({
        environment: "local",
        event: "test",
        level: "debug",
        service: "orchestrator",
        timestamp: NOW.toISOString(),
      }),
      error: () => ({
        environment: "local",
        event: "test",
        level: "error",
        service: "orchestrator",
        timestamp: NOW.toISOString(),
      }),
      info: () => ({
        environment: "local",
        event: "test",
        level: "info",
        service: "orchestrator",
        timestamp: NOW.toISOString(),
      }),
      warn: () => ({
        environment: "local",
        event: "test",
        level: "warn",
        service: "orchestrator",
        timestamp: NOW.toISOString(),
      }),
    },
    now: () => NOW,
    random: () => 0,
  });
}

describe("R2 upload Queue integration", () => {
  it("atomically creates generation one and remains idempotent after redelivery", async () => {
    await insertJob();
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(1));
    const head = await env.RECORDINGS.head(SOURCE_KEY);
    if (head === null) {
      throw new Error("Expected the source object to exist");
    }
    const first = new FakeMessage(event(head.etag));
    const redelivery = new FakeMessage(event(head.etag), 2);

    await process(first);
    await process(redelivery);

    expect(first.acknowledgements).toBe(1);
    expect(redelivery.acknowledgements).toBe(1);
    expect(first.retryDelays).toEqual([]);
    expect(redelivery.retryDelays).toEqual([]);
    const storedJob = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          actual_size_bytes,
          active_attempt_id,
          source_etag,
          status,
          version
        FROM jobs
        WHERE id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(storedJob).toEqual({
      actual_size_bytes: 1024,
      active_attempt_id: ATTEMPT_ID,
      source_etag: head.etag,
      status: "SUBMISSION_PENDING",
      version: 3,
    });

    const attempts = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          claim_consumed_at,
          claim_expires_at,
          claim_issued_at,
          claim_token_hash,
          generation,
          heartbeat_expires_at,
          heartbeat_issued_at,
          heartbeat_token_hash,
          result_prefix,
          status
        FROM job_attempts
        WHERE job_id = ?1
      `,
    )
      .bind(JOB_ID)
      .all();
    expect(attempts.results).toHaveLength(1);
    expect(attempts.results[0]).toMatchObject({
      claim_consumed_at: null,
      claim_expires_at: null,
      claim_issued_at: null,
      generation: 1,
      heartbeat_expires_at: null,
      heartbeat_issued_at: null,
      heartbeat_token_hash: null,
      claim_token_hash: null,
      result_prefix: `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/`,
      status: "SUBMISSION_PENDING",
    });

    const eventCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first<{ count: number }>();
    expect(eventCount?.count).toBe(1);
  });

  it("creates the attempt when upload-complete recorded the same source first", async () => {
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(1));
    const head = await env.RECORDINGS.head(SOURCE_KEY);
    if (head === null) {
      throw new Error("Expected the source object to exist");
    }
    await insertJob({
      actualSizeBytes: 1024,
      sourceEtag: head.etag,
      status: "UPLOADED",
      version: 3,
    });
    const message = new FakeMessage(event(head.etag));

    await process(message);

    expect(message.acknowledgements).toBe(1);
    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT active_attempt_id, status, version FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(stored).toEqual({
      active_attempt_id: ATTEMPT_ID,
      status: "SUBMISSION_PENDING",
      version: 4,
    });
  });

  it("fails a wrong-sized source without creating an attempt", async () => {
    await insertJob();
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1025).fill(1));
    const head = await env.RECORDINGS.head(SOURCE_KEY);
    if (head === null) {
      throw new Error("Expected the source object to exist");
    }
    const message = new FakeMessage(event(head.etag, head.size));

    await process(message);

    expect(message.acknowledgements).toBe(1);
    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT active_attempt_id, error_code, status FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(stored).toEqual({
      active_attempt_id: null,
      error_code: "SOURCE_SIZE_MISMATCH",
      status: "FAILED",
    });
    const attemptCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_attempts WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first<{ count: number }>();
    expect(attemptCount?.count).toBe(0);
  });

  it("stops an existing attempt after the exact source key is overwritten", async () => {
    await insertJob();
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(1));
    const original = await env.RECORDINGS.head(SOURCE_KEY);
    if (original === null) {
      throw new Error("Expected the source object to exist");
    }
    await process(new FakeMessage(event(original.etag)));

    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(2));
    const replacement = await env.RECORDINGS.head(SOURCE_KEY);
    if (replacement === null) {
      throw new Error("Expected the replacement object to exist");
    }
    const mutation = new FakeMessage(event(replacement.etag));
    await process(mutation);

    expect(mutation.acknowledgements).toBe(1);
    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT error_code, source_etag, status, version FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(stored).toEqual({
      error_code: "SOURCE_ETAG_CHANGED",
      source_etag: original.etag,
      status: "SOURCE_MUTATED",
      version: 4,
    });
    const attemptCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_attempts WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first<{ count: number }>();
    expect(attemptCount?.count).toBe(1);
  });
});
