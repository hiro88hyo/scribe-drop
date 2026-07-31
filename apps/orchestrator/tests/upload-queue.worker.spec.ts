import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { R2EventNotification } from "@scribe-drop/contracts";
import { createStructuredLogger } from "@scribe-drop/observability";
import { DeterministicFaultPlan, inspectStructuredLogs } from "@scribe-drop/test-support";

import { handleUploadQueueBatch, type UploadQueueMessage } from "../src/upload-queue-consumer.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const MUTATION_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const CONCURRENT_MUTATION_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const OWNER_HASH = "0123456789abcdef0123456789abcdef";
const SOURCE_KEY = `incoming/${OWNER_HASH}/${JOB_ID}/ABCDEFGHIJKLMNOPQRSTUV/source.m4a`;

class FakeMessage implements UploadQueueMessage {
  readonly attempts: number;
  readonly body: unknown;
  acknowledgements = 0;
  retryDelays: number[] = [];
  readonly #beforeAck: (() => void) | undefined;

  constructor(body: unknown, attempts = 1, beforeAck?: () => void) {
    this.attempts = attempts;
    this.body = body;
    this.#beforeAck = beforeAck;
  }

  ack(): void {
    this.#beforeAck?.();
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

async function process(
  message: FakeMessage,
  records: string[] = [],
  eventId = EVENT_ID,
): Promise<void> {
  await handleUploadQueueBatch({ messages: [message] }, env, {
    createAttemptId: () => ATTEMPT_ID,
    createEventId: () => eventId,
    logger: createStructuredLogger({
      environment: "local",
      now: () => NOW,
      service: "orchestrator",
      sink: (record) => {
        records.push(record);
      },
    }),
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

  it("remains idempotent when D1 commits before Queue acknowledgement fails", async () => {
    await insertJob();
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(1));
    const head = await env.RECORDINGS.head(SOURCE_KEY);
    if (head === null) {
      throw new Error("Expected the source object to exist");
    }
    const faults = new DeterministicFaultPlan([
      {
        occurrences: [1],
        point: "queue.ack",
      },
    ]);
    const records: string[] = [];
    const failedAcknowledgement = new FakeMessage(event(head.etag), 1, () => {
      faults.hit("queue.ack");
    });
    const redelivery = new FakeMessage(event(head.etag), 2);

    await process(failedAcknowledgement, records);
    await process(redelivery, records);

    expect(failedAcknowledgement.acknowledgements).toBe(0);
    expect(failedAcknowledgement.retryDelays).toEqual([1]);
    expect(redelivery.acknowledgements).toBe(1);
    expect(redelivery.retryDelays).toEqual([]);
    const state = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          jobs.version,
          attempts.generation,
          attempts.status AS attempt_status,
          (SELECT COUNT(*) FROM job_attempts WHERE job_id = jobs.id) AS attempts,
          (SELECT COUNT(*) FROM job_events WHERE job_id = jobs.id) AS events,
          (SELECT COUNT(*) FROM runpod_submissions WHERE attempt_id = attempts.id) AS submissions,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = jobs.id) AS outbox
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(state).toEqual({
      attempt_status: "SUBMISSION_PENDING",
      attempts: 1,
      events: 1,
      generation: 1,
      job_status: "SUBMISSION_PENDING",
      outbox: 0,
      submissions: 0,
      version: 3,
    });
    expect(
      inspectStructuredLogs(records, [SOURCE_KEY, head.etag, "fixture transcript"]).events,
    ).toEqual([
      "upload_event_ingested",
      "upload_event_dependency_failure",
      "upload_event_duplicate",
    ]);
    expect(() => {
      faults.assertExhausted();
    }).not.toThrow();
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
    const concurrentMutation = new FakeMessage(event(replacement.etag));
    await Promise.all([
      process(mutation, [], MUTATION_EVENT_ID),
      process(concurrentMutation, [], CONCURRENT_MUTATION_EVENT_ID),
    ]);

    expect(mutation.acknowledgements).toBe(1);
    expect(concurrentMutation.acknowledgements).toBe(1);
    const stored = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.error_code,
          jobs.source_etag,
          jobs.status,
          jobs.version,
          attempts.error_code AS attempt_error_code,
          attempts.status AS attempt_status,
          (SELECT COUNT(*) FROM job_events WHERE job_id = jobs.id) AS events
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(stored).toEqual({
      attempt_error_code: "SOURCE_ETAG_CHANGED",
      attempt_status: "FAILED",
      error_code: "SOURCE_ETAG_CHANGED",
      events: 2,
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

  it("revokes an active attempt when its source is overwritten during processing", async () => {
    await insertJob();
    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(1));
    const original = await env.RECORDINGS.head(SOURCE_KEY);
    if (original === null) {
      throw new Error("Expected the source object to exist");
    }
    await process(new FakeMessage(event(original.etag)));
    await env.SCRIBE_DROP_DB.batch([
      env.SCRIBE_DROP_DB.prepare(
        `
          UPDATE job_attempts
          SET
            status = 'RUNNING',
            winning_runpod_job_id = 'running-provider-job',
            claimed_at = ?2,
            updated_at = ?2
          WHERE id = ?1
        `,
      ).bind(ATTEMPT_ID, NOW.toISOString()),
      env.SCRIBE_DROP_DB.prepare(
        `
          INSERT INTO runpod_submissions (
            runpod_job_id,
            attempt_id,
            is_winner,
            source,
            created_at,
            updated_at
          ) VALUES ('running-provider-job', ?1, 1, 'worker_claim', ?2, ?2)
        `,
      ).bind(ATTEMPT_ID, NOW.toISOString()),
      env.SCRIBE_DROP_DB.prepare(
        `
          UPDATE jobs
          SET status = 'RUNNING', version = version + 1, updated_at = ?2
          WHERE id = ?1
        `,
      ).bind(JOB_ID, NOW.toISOString()),
    ]);

    await env.RECORDINGS.put(SOURCE_KEY, new Uint8Array(1024).fill(2));
    const replacement = await env.RECORDINGS.head(SOURCE_KEY);
    if (replacement === null) {
      throw new Error("Expected the replacement object to exist");
    }
    const mutation = new FakeMessage(event(replacement.etag));
    await process(mutation, [], MUTATION_EVENT_ID);

    expect(mutation.acknowledgements).toBe(1);
    expect(mutation.retryDelays).toEqual([]);
    const state = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          jobs.error_code AS job_error_code,
          jobs.version,
          attempts.status AS attempt_status,
          attempts.error_code AS attempt_error_code,
          attempts.heartbeat_revoked_at,
          (SELECT COUNT(*) FROM runpod_submissions WHERE attempt_id = attempts.id) AS submissions,
          (SELECT COUNT(*) FROM job_events WHERE job_id = jobs.id) AS events,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = jobs.id) AS outbox
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(state).toEqual({
      attempt_error_code: "SOURCE_ETAG_CHANGED",
      attempt_status: "FAILED",
      events: 2,
      heartbeat_revoked_at: null,
      job_error_code: "SOURCE_ETAG_CHANGED",
      job_status: "SOURCE_MUTATED",
      outbox: 0,
      submissions: 1,
      version: 5,
    });
    const mutationEvent = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT actor, event_type, metadata_json
        FROM job_events
        WHERE job_id = ?1 AND event_type = 'source_mutated'
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(mutationEvent).toEqual({
      actor: "queue",
      event_type: "source_mutated",
      metadata_json: null,
    });
  });
});
