import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1MaintenanceRepository } from "../src/maintenance-repository.js";

const NOW = "2026-07-25T01:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
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
        upload_expires_at,
        created_at,
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
        'UPLOADING',
        '{"language":"ja"}',
        '2026-07-25T00:15:00.000Z',
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:00.000Z'
      )
    `,
  )
    .bind(JOB_ID, `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.m4a`)
    .run();
});

describe("maintenance repository", () => {
  it("expires an overdue upload once with an audit event", async () => {
    const repository = createD1MaintenanceRepository(env.SCRIBE_DROP_DB);
    await expect(repository.findExpiredUploads("2026-07-25T00:14:59.999Z", 25)).resolves.toEqual(
      [],
    );
    await expect(repository.findExpiredUploads(NOW, 25)).resolves.toEqual([
      {
        jobId: JOB_ID,
        uploadExpiresAt: "2026-07-25T00:15:00.000Z",
      },
    ]);
    await expect(
      repository.expireUpload({
        eventId: EVENT_ID,
        jobId: JOB_ID,
        timestamp: NOW,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.expireUpload({
        eventId: EVENT_ID,
        jobId: JOB_ID,
        timestamp: NOW,
      }),
    ).resolves.toBe(false);

    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, error_code, version FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      error_code: "UPLOAD_EXPIRED",
      status: "EXPIRED",
      version: 2,
    });
    const event = await env.SCRIBE_DROP_DB.prepare(
      "SELECT event_type, actor FROM job_events WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(event).toEqual({
      actor: "orchestrator",
      event_type: "upload_expired",
    });
  });
});
