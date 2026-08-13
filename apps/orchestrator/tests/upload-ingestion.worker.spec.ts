import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { GpuExecutionSelection } from "../src/config.js";
import { createD1UploadIngestionRepository } from "../src/upload-ingestion-repository.js";

const NOW = "2026-08-13T00:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OWNER_HASH = "a".repeat(32);
const SOURCE_KEY = `incoming/${OWNER_HASH}/${JOB_ID}/${"n".repeat(22)}/source.m4a`;

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs;");
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO jobs (
        id, owner_sub, owner_email, title, original_filename, source_bucket, source_key,
        source_content_type, expected_size_bytes, status, options_json, created_at, updated_at
      ) VALUES (
        ?1, 'owner-sub', 'owner@example.invalid', 'Upload', 'source.m4a',
        'recording-transcriber-test', ?2, 'audio/mp4', 1024, 'UPLOADING',
        '{"language":"auto","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
        ?3, ?3
      )
    `,
  )
    .bind(JOB_ID, SOURCE_KEY, NOW)
    .run();
});

async function ingest(selection: GpuExecutionSelection): Promise<string> {
  const repository = createD1UploadIngestionRepository(env.SCRIBE_DROP_DB);
  const job = await repository.findSourceJob(JOB_ID);
  if (job === undefined) throw new Error("missing upload job");
  return repository.ingestSource({
    attemptId: ATTEMPT_ID,
    eventId: EVENT_ID,
    job,
    ownerHash: OWNER_HASH,
    selection,
    sizeBytes: 1024,
    sourceEtag: "etag",
    timestamp: NOW,
  });
}

describe("D1 upload provider snapshot", () => {
  it("atomically fixes a Cloud Run contract-v2 attempt and provider aggregate", async () => {
    await expect(
      ingest({
        contractVersion: 2,
        kind: "cloud_run_jobs",
        policy: "cloud_run_jobs_l4_v1",
      }),
    ).resolves.toBe("ingested");

    const row = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          attempts.provider_kind,
          attempts.provider_policy,
          attempts.execution_contract_version,
          attempts.execution_options_json,
          executions.provider_kind AS execution_provider_kind,
          executions.provider_policy AS execution_provider_policy,
          executions.status AS execution_status
        FROM job_attempts AS attempts
        INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
        WHERE attempts.id = ?1
      `,
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(row).toEqual({
      execution_contract_version: 2,
      execution_options_json:
        '{"contractVersion":2,"language":"auto","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
      execution_provider_kind: "cloud_run_jobs",
      execution_provider_policy: "cloud_run_jobs_l4_v1",
      execution_status: "PENDING",
      provider_kind: "cloud_run_jobs",
      provider_policy: "cloud_run_jobs_l4_v1",
    });
  });

  it("recognizes only an exact persisted selection as a duplicate", async () => {
    const selection = {
      contractVersion: 1,
      kind: "runpod_serverless",
      policy: "runpod_serverless_v1",
    } as const;
    await expect(ingest(selection)).resolves.toBe("ingested");
    const repository = createD1UploadIngestionRepository(env.SCRIBE_DROP_DB);
    const job = await repository.findSourceJob(JOB_ID);
    if (job === undefined) throw new Error("missing ingested job");
    await expect(
      repository.ingestSource({
        attemptId: ATTEMPT_ID,
        eventId: EVENT_ID,
        job,
        ownerHash: OWNER_HASH,
        selection,
        sizeBytes: 1024,
        sourceEtag: "etag",
        timestamp: NOW,
      }),
    ).resolves.toBe("duplicate");
    await expect(
      repository.ingestSource({
        attemptId: ATTEMPT_ID,
        eventId: EVENT_ID,
        job,
        ownerHash: OWNER_HASH,
        selection: {
          contractVersion: 2,
          kind: "cloud_run_jobs",
          policy: "cloud_run_jobs_l4_v1",
        },
        sizeBytes: 1024,
        sourceEtag: "etag",
        timestamp: NOW,
      }),
    ).resolves.toBe("ignored");
  });
});
