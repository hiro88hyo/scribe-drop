import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { processPendingDeletions } from "../src/deletion-service.js";

const NOW = new Date("2026-07-26T04:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIRST_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SECOND_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const OUTBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const OWNER_HASH = "0123456789abcdef0123456789abcdef";
const SOURCE_KEY = `incoming/${OWNER_HASH}/${JOB_ID}/nonce/source.mp3`;
const FIRST_PREFIX = `results/${OWNER_HASH}/${JOB_ID}/${FIRST_ATTEMPT_ID}/`;
const SECOND_PREFIX = `results/${OWNER_HASH}/${JOB_ID}/${SECOND_ATTEMPT_ID}/`;
const UNRELATED_KEY = "results/unrelated/keep.txt";

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

async function seedDeletion(): Promise<void> {
  const createdAt = new Date(NOW.getTime() - 60_000).toISOString();
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
        updated_at
      ) VALUES (
        ?1,
        'owner-sub',
        'owner@example.invalid',
        'Deletion test',
        'source.mp3',
        'recording-transcriber-test',
        ?2,
        'audio/mpeg',
        1024,
        'COMPLETED',
        '{"language":"ja"}',
        ?3,
        ?3
      )
    `,
  )
    .bind(JOB_ID, SOURCE_KEY, createdAt)
    .run();
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          result_prefix,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 1, 'FAILED', ?3, ?4, ?4)
      `,
    ).bind(FIRST_ATTEMPT_ID, JOB_ID, FIRST_PREFIX, createdAt),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          result_prefix,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 2, 'COMPLETED', ?3, ?4, ?4)
      `,
    ).bind(SECOND_ATTEMPT_ID, JOB_ID, SECOND_PREFIX, createdAt),
  ]);
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO runpod_submissions (
          runpod_job_id,
          attempt_id,
          is_winner,
          source,
          created_at,
          updated_at
        ) VALUES ('runpod-first-placeholder', ?1, 0, 'submit_response', ?2, ?2)
      `,
    ).bind(FIRST_ATTEMPT_ID, createdAt),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO runpod_submissions (
          runpod_job_id,
          attempt_id,
          is_winner,
          source,
          created_at,
          updated_at
        ) VALUES ('runpod-second-placeholder', ?1, 1, 'submit_response', ?2, ?2)
      `,
    ).bind(SECOND_ATTEMPT_ID, createdAt),
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
    ).bind(JOB_ID, SECOND_ATTEMPT_ID, `${SECOND_PREFIX}transcript.md`, "a".repeat(64), createdAt),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_events (
          id,
          job_id,
          attempt_id,
          event_type,
          actor,
          metadata_json,
          created_at
        ) VALUES (?1, ?2, ?3, 'job_delete_requested', 'user', NULL, ?4)
      `,
    ).bind(EVENT_ID, JOB_ID, SECOND_ATTEMPT_ID, createdAt),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO notification_outbox (
          id,
          job_id,
          status,
          attempt_count,
          next_attempt_at,
          created_at
        ) VALUES (?1, ?2, 'pending', 0, ?3, ?3)
      `,
    ).bind(OUTBOX_ID, JOB_ID, createdAt),
  ]);
  await env.SCRIBE_DROP_DB.prepare(
    `
      UPDATE jobs
      SET
        active_attempt_id = ?2,
        deleted_at = ?3,
        deletion_not_before = ?3,
        deletion_next_attempt_at = ?3,
        updated_at = ?3,
        version = version + 1
      WHERE id = ?1
    `,
  )
    .bind(JOB_ID, SECOND_ATTEMPT_ID, createdAt)
    .run();
  await Promise.all([
    env.RECORDINGS.put(SOURCE_KEY, "source"),
    env.RECORDINGS.put(`${FIRST_PREFIX}partial.json`, "{}"),
    env.RECORDINGS.put(`${SECOND_PREFIX}manifest.json`, "{}"),
    env.RECORDINGS.put(`${SECOND_PREFIX}transcript.md`, "text"),
    env.RECORDINGS.put(UNRELATED_KEY, "keep"),
  ]);
}

describe("asynchronous user deletion", () => {
  it("deletes exact R2 ownership and cascades all D1 child records", async () => {
    await seedDeletion();

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
            cancel: () => Promise.resolve({ outcome: "accepted" }),
            getStatus: () => Promise.resolve({ outcome: "not_found" }),
          }),
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({
      completedCount: 1,
      deferredCount: 0,
      retryCount: 0,
    });

    for (const table of [
      "jobs",
      "job_attempts",
      "runpod_submissions",
      "job_artifacts",
      "job_events",
      "notification_outbox",
    ]) {
      const count = await env.SCRIBE_DROP_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first<{ count: number }>();
      expect(count?.count).toBe(0);
    }
    await expect(env.RECORDINGS.head(SOURCE_KEY)).resolves.toBeNull();
    await expect(env.RECORDINGS.head(`${FIRST_PREFIX}partial.json`)).resolves.toBeNull();
    await expect(env.RECORDINGS.head(`${SECOND_PREFIX}manifest.json`)).resolves.toBeNull();
    await expect(env.RECORDINGS.head(UNRELATED_KEY)).resolves.not.toBeNull();
  });
});
