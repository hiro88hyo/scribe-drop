import { createStructuredLogger } from "@scribe-drop/observability";
import type { StructuredLogger } from "@scribe-drop/observability";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { processPendingDeletions } from "../src/deletion-service.js";
import { processRetention } from "../src/retention-service.js";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const RETAINED_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RETAINED_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EXPIRED_AUDIT_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const OWNER_HASH = "0123456789abcdef0123456789abcdef";
const SOURCE_KEY = `incoming/${OWNER_HASH}/${RETAINED_JOB_ID}/nonce/source.mp3`;
const RESULT_PREFIX = `results/${OWNER_HASH}/${RETAINED_JOB_ID}/${RETAINED_ATTEMPT_ID}/`;
const EXPIRED_SOURCE_KEY = `incoming/${OWNER_HASH}/${EXPIRED_AUDIT_JOB_ID}/nonce/source.mp3`;

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
  const objects = await env.RECORDINGS.list();
  await Promise.all(objects.objects.map((object) => env.RECORDINGS.delete(object.key)));
});

function logger(): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: () => undefined,
  });
}

async function insertCompletedJob(input: {
  readonly createdAt: string;
  readonly jobId: string;
  readonly sourceKey: string;
  readonly uploadedAt: string;
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
        status,
        options_json,
        created_at,
        uploaded_at,
        completed_at,
        updated_at
      ) VALUES (
        ?1,
        'owner-sub',
        'owner@example.invalid',
        'Retention test',
        'source.mp3',
        'recording-transcriber-test',
        ?2,
        'audio/mpeg',
        1024,
        'COMPLETED',
        '{"language":"ja"}',
        ?3,
        ?4,
        ?4,
        ?4
      )
    `,
  )
    .bind(input.jobId, input.sourceKey, input.createdAt, input.uploadedAt)
    .run();
}

async function seedRetentionCandidates(): Promise<void> {
  const oneHundredDaysAgo = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1_000).toISOString();
  const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1_000).toISOString();
  const twoHundredDaysAgo = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1_000).toISOString();
  await insertCompletedJob({
    createdAt: oneHundredDaysAgo,
    jobId: RETAINED_JOB_ID,
    sourceKey: SOURCE_KEY,
    uploadedAt: tenDaysAgo,
  });
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO job_attempts (
        id,
        job_id,
        generation,
        status,
        result_prefix,
        completed_at,
        created_at,
        updated_at
      ) VALUES (?1, ?2, 1, 'COMPLETED', ?3, ?4, ?4, ?4)
    `,
  )
    .bind(RETAINED_ATTEMPT_ID, RETAINED_JOB_ID, RESULT_PREFIX, oneHundredDaysAgo)
    .run();
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1").bind(
      RETAINED_JOB_ID,
      RETAINED_ATTEMPT_ID,
    ),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_artifacts (
          job_id,
          attempt_id,
          format,
          object_key,
          size_bytes,
          sha256,
          created_at
        ) VALUES (?1, ?2, 'markdown', ?3, 10, ?4, ?5)
      `,
    ).bind(
      RETAINED_JOB_ID,
      RETAINED_ATTEMPT_ID,
      `${RESULT_PREFIX}transcript.md`,
      "a".repeat(64),
      oneHundredDaysAgo,
    ),
  ]);
  await insertCompletedJob({
    createdAt: twoHundredDaysAgo,
    jobId: EXPIRED_AUDIT_JOB_ID,
    sourceKey: EXPIRED_SOURCE_KEY,
    uploadedAt: twoHundredDaysAgo,
  });
  await Promise.all([
    env.RECORDINGS.put(SOURCE_KEY, "source"),
    env.RECORDINGS.put(`${RESULT_PREFIX}partial.json`, "{}"),
  ]);
}

describe("configured retention", () => {
  it("separates source, result, and audit expiry and reuses safe deletion cleanup", async () => {
    await seedRetentionCandidates();

    await expect(
      processRetention(
        {
          AUDIT_RETENTION_DAYS: "180",
          MULTIPART_RETENTION_HOURS: "24",
          RECORDINGS: env.RECORDINGS,
          RESULT_RETENTION_DAYS: "90",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
          SOURCE_RETENTION_DAYS: "7",
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({
      auditScheduledCount: 1,
      resultDeletedCount: 1,
      retryCount: 0,
      sourceDeletedCount: 2,
    });

    const retainedJob = await env.SCRIBE_DROP_DB.prepare(
      "SELECT deleted_at, source_deleted_at FROM jobs WHERE id = ?1",
    )
      .bind(RETAINED_JOB_ID)
      .first();
    expect(retainedJob).toEqual({
      deleted_at: null,
      source_deleted_at: NOW.toISOString(),
    });
    const retainedAttempt = await env.SCRIBE_DROP_DB.prepare(
      "SELECT results_deleted_at FROM job_attempts WHERE id = ?1",
    )
      .bind(RETAINED_ATTEMPT_ID)
      .first();
    expect(retainedAttempt).toEqual({
      results_deleted_at: NOW.toISOString(),
    });
    const artifacts = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_artifacts WHERE job_id = ?1",
    )
      .bind(RETAINED_JOB_ID)
      .first<{ count: number }>();
    expect(artifacts?.count).toBe(0);
    await expect(env.RECORDINGS.head(SOURCE_KEY)).resolves.toBeNull();
    await expect(env.RECORDINGS.head(`${RESULT_PREFIX}partial.json`)).resolves.toBeNull();

    const expiredAudit = await env.SCRIBE_DROP_DB.prepare(
      "SELECT deleted_at, deletion_not_before FROM jobs WHERE id = ?1",
    )
      .bind(EXPIRED_AUDIT_JOB_ID)
      .first();
    expect(expiredAudit).toEqual({
      deleted_at: NOW.toISOString(),
      deletion_not_before: NOW.toISOString(),
    });
    const auditEvent = await env.SCRIBE_DROP_DB.prepare(
      "SELECT event_type, actor FROM job_events WHERE job_id = ?1",
    )
      .bind(EXPIRED_AUDIT_JOB_ID)
      .first();
    expect(auditEvent).toEqual({
      actor: "orchestrator",
      event_type: "job_retention_expired",
    });

    await expect(
      processPendingDeletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createRunpodClient: () => ({
            cancel: () => Promise.resolve({ outcome: "not_found" }),
            getStatus: () => Promise.resolve({ outcome: "not_found" }),
          }),
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({
      completedCount: 1,
    });
    await expect(
      env.SCRIBE_DROP_DB.prepare("SELECT id FROM jobs WHERE id = ?1")
        .bind(EXPIRED_AUDIT_JOB_ID)
        .first(),
    ).resolves.toBeNull();
    await expect(
      env.SCRIBE_DROP_DB.prepare("SELECT id FROM jobs WHERE id = ?1").bind(RETAINED_JOB_ID).first(),
    ).resolves.not.toBeNull();
  });
});
