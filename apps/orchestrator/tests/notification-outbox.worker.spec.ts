import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1NotificationOutboxRepository } from "../src/notification-outbox-repository.js";

const NOW = "2026-07-25T01:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OUTBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const NEXT_OUTBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const EXECUTION_OPTIONS = JSON.stringify({
  contractVersion: 1,
  language: "auto",
  model: "large-v3-turbo",
  outputFormats: ["markdown", "json", "srt"],
  vad: true,
});

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
          provider_kind,
          provider_policy,
          execution_contract_version,
          execution_options_json,
          created_at,
          updated_at
        ) VALUES (
          ?1, ?2, 1, 'COMPLETED', ?3, 120000, ?4, 'runpod_serverless',
          'runpod_serverless_v1', 1, ?5, ?4, ?4
        )
      `,
    ).bind(
      ATTEMPT_ID,
      JOB_ID,
      `results/0123456789abcdef0123456789abcdef/${JOB_ID}/${ATTEMPT_ID}/`,
      NOW,
      EXECUTION_OPTIONS,
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
          job_version,
          status,
          attempt_count,
          next_attempt_at,
          created_at
        ) VALUES (?1, ?2, 1, 'PENDING', 0, ?3, ?3)
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
      jobVersion: 1,
      runpodExecutionMs: 120_000,
      terminalStatus: "COMPLETED",
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

  it("enqueues and sends a failed job without completion metadata", async () => {
    await env.SCRIBE_DROP_DB.batch([
      env.SCRIBE_DROP_DB.prepare("DELETE FROM notification_outbox WHERE job_id = ?1").bind(JOB_ID),
      env.SCRIBE_DROP_DB.prepare(
        `
          UPDATE jobs
          SET
            status = 'FAILED',
            duration_seconds = NULL,
            completed_at = NULL,
            failed_at = ?2,
            notified_at = NULL,
            updated_at = ?2
          WHERE id = ?1
        `,
      ).bind(JOB_ID, NOW),
    ]);
    const repository = createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB);

    const enqueueResults = await Promise.all([
      repository.enqueueNextTerminal(NEXT_OUTBOX_ID, NOW),
      repository.enqueueNextTerminal(OUTBOX_ID, NOW),
    ]);
    expect(enqueueResults.toSorted()).toEqual([false, true]);
    const delivery = await repository.claimNext(NOW, "2026-07-25T01:02:00.000Z");
    expect(delivery).toMatchObject({
      attemptCount: 1,
      durationSeconds: null,
      jobId: JOB_ID,
      jobVersion: 1,
      runpodExecutionMs: 120_000,
      terminalStatus: "FAILED",
      title: "Verification job",
    });
    expect([OUTBOX_ID, NEXT_OUTBOX_ID]).toContain(delivery?.id);
    if (delivery === undefined) {
      throw new Error("Expected a failure notification lease");
    }
    await expect(repository.markSent(delivery, NOW)).resolves.toBe(true);
    await expect(repository.claimNext(NOW, "2026-07-25T01:02:00.000Z")).resolves.toBeUndefined();
  });

  it("rejects a stale sending lease and rearms the outbox for the next job version", async () => {
    const repository = createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB);
    const initialDelivery = await repository.claimNext(NOW, "2026-07-25T01:02:00.000Z");
    if (initialDelivery === undefined) {
      throw new Error("Expected an initial notification lease");
    }
    const nextTimestamp = "2026-07-25T02:00:00.000Z";
    await env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE jobs
        SET
          status = 'FAILED',
          duration_seconds = NULL,
          completed_at = NULL,
          failed_at = ?2,
          notified_at = NULL,
          updated_at = ?2,
          version = version + 1
        WHERE id = ?1
      `,
    )
      .bind(JOB_ID, nextTimestamp)
      .run();

    await expect(repository.enqueueNextTerminal(NEXT_OUTBOX_ID, nextTimestamp)).resolves.toBe(true);
    await expect(repository.markSent(initialDelivery, nextTimestamp)).resolves.toBe(false);
    const delivery = await repository.claimNext(nextTimestamp, "2026-07-25T02:02:00.000Z");
    expect(delivery).toMatchObject({
      attemptCount: 1,
      id: OUTBOX_ID,
      jobVersion: 2,
      terminalStatus: "FAILED",
    });
    const rows = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_outbox WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(rows).toEqual({ count: 1 });
  });

  it("does not lease a notification when the provider aggregate drifts", async () => {
    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE provider_executions SET status = 'RUNNING' WHERE attempt_id = ?1",
    )
      .bind(ATTEMPT_ID)
      .run();

    await expect(
      createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB).claimNext(
        NOW,
        "2026-07-25T01:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
  });
});
