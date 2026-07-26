import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1NotificationOutboxRepository } from "../src/notification-outbox-repository.js";

const NOW = "2026-07-25T01:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OUTBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
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
          duration_seconds,
          status,
          options_json,
          created_at,
          completed_at,
          updated_at
        ) VALUES (
          ?1,
          'owner-sub',
          'owner@example.invalid',
          'Verification job',
          'recording.m4a',
          'recording-transcriber-test',
          ?2,
          'audio/mp4',
          1024,
          1024,
          'source-etag',
          60,
          'COMPLETED',
          '{"language":"ja"}',
          ?3,
          ?3,
          ?3
        )
      `,
    ).bind(JOB_ID, `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.m4a`, NOW),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          result_prefix,
          runpod_execution_ms,
          completed_at,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 1, 'COMPLETED', ?3, 120000, ?4, ?4, ?4)
      `,
    ).bind(
      ATTEMPT_ID,
      JOB_ID,
      `results/0123456789abcdef0123456789abcdef/${JOB_ID}/${ATTEMPT_ID}/`,
      NOW,
    ),
    env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1").bind(
      JOB_ID,
      ATTEMPT_ID,
    ),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO notification_outbox (
          id,
          job_id,
          status,
          attempt_count,
          next_attempt_at,
          created_at
        ) VALUES (?1, ?2, 'PENDING', 0, ?3, ?3)
      `,
    ).bind(OUTBOX_ID, JOB_ID, NOW),
  ]);
});

describe("notification outbox repository", () => {
  it("leases one delivery across concurrent dispatchers and marks it sent", async () => {
    const repository = createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB);
    const claims = await Promise.all([
      repository.claimNext(NOW, "2026-07-25T01:02:00.000Z"),
      repository.claimNext(NOW, "2026-07-25T01:02:00.000Z"),
    ]);
    const delivery = claims.find((claim) => claim !== undefined);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(delivery).toEqual({
      attemptCount: 1,
      durationSeconds: 60,
      id: OUTBOX_ID,
      jobId: JOB_ID,
      runpodExecutionMs: 120_000,
      title: "Verification job",
    });
    if (delivery === undefined) {
      throw new Error("Expected one notification lease");
    }
    await expect(repository.markSent(delivery, NOW)).resolves.toBe(true);
    await expect(repository.markSent(delivery, NOW)).resolves.toBe(false);

    const outbox = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, attempt_count, next_attempt_at, last_error, sent_at FROM notification_outbox WHERE id = ?1",
    )
      .bind(OUTBOX_ID)
      .first();
    expect(outbox).toEqual({
      attempt_count: 1,
      last_error: null,
      next_attempt_at: null,
      sent_at: NOW,
      status: "SENT",
    });
    const job = await env.SCRIBE_DROP_DB.prepare("SELECT notified_at FROM jobs WHERE id = ?1")
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({ notified_at: NOW });
  });

  it("releases retryable delivery and reclaims it only after backoff", async () => {
    const repository = createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB);
    const delivery = await repository.claimNext(NOW, "2026-07-25T01:02:00.000Z");
    if (delivery === undefined) {
      throw new Error("Expected a notification lease");
    }
    await expect(
      repository.release({
        delivery,
        errorCode: "DISCORD_UNAVAILABLE",
        nextAttemptAt: "2026-07-25T01:05:00.000Z",
        status: "PENDING",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claimNext("2026-07-25T01:04:59.999Z", "2026-07-25T01:06:59.999Z"),
    ).resolves.toBeUndefined();
    await expect(
      repository.claimNext("2026-07-25T01:05:00.000Z", "2026-07-25T01:07:00.000Z"),
    ).resolves.toMatchObject({
      attemptCount: 2,
      id: OUTBOX_ID,
    });
  });
});
