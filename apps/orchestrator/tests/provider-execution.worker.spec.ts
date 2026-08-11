import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1ProviderExecutionRepository } from "../src/provider-execution-repository.js";

const NOW = "2026-08-11T00:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPTIONS = JSON.stringify({
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
  await env.SCRIBE_DROP_DB.exec(`
    DELETE FROM jobs;
  `);
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO jobs (
        id, owner_sub, owner_email, title, original_filename, source_bucket, source_key,
        source_content_type, expected_size_bytes, status, options_json, created_at, updated_at
      ) VALUES (
        ?1, 'owner-sub', 'owner@example.invalid', 'Compatibility', 'source.m4a',
        'recording-transcriber-test', ?2, 'audio/mp4', 1024, 'SUBMISSION_PENDING', ?3, ?4, ?4
      )
    `,
  )
    .bind(JOB_ID, `incoming/owner/${JOB_ID}/nonce/source.m4a`, OPTIONS, NOW)
    .run();
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO job_attempts (
        id, job_id, generation, status, result_prefix, provider_kind, provider_policy,
        execution_contract_version, execution_options_json, created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, 'SUBMISSION_PENDING', ?3, 'runpod_serverless',
        'runpod_serverless_v1', 1, ?4, ?5, ?5
      )
    `,
  )
    .bind(ATTEMPT_ID, JOB_ID, `results/owner/${JOB_ID}/${ATTEMPT_ID}/`, OPTIONS, NOW)
    .run();
  await env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1")
    .bind(JOB_ID, ATTEMPT_ID)
    .run();
});

describe("provider execution compatibility repository", () => {
  it("creates and reads an exact RunPod legacy mirror", async () => {
    const repository = createD1ProviderExecutionRepository(env.SCRIBE_DROP_DB);

    await expect(repository.findCompatibleExecution(ATTEMPT_ID)).resolves.toMatchObject({
      attemptId: ATTEMPT_ID,
      cleanupStatus: "NOT_REQUESTED",
      contractVersion: 1,
      executionId: ATTEMPT_ID,
      providerHandle: null,
      status: "PENDING",
      version: 1,
    });
  });

  it("dual-writes legacy transitions and rejects an immutable binding change", async () => {
    await env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE job_attempts
        SET status = 'SUBMITTING', submission_outcome = 'unknown', updated_at = ?2
        WHERE id = ?1
      `,
    )
      .bind(ATTEMPT_ID, "2026-08-11T00:01:00.000Z")
      .run();
    const repository = createD1ProviderExecutionRepository(env.SCRIBE_DROP_DB);
    await expect(repository.findCompatibleExecution(ATTEMPT_ID)).resolves.toMatchObject({
      status: "CREATING",
      version: 2,
    });

    await expect(
      env.SCRIBE_DROP_DB.prepare(
        "UPDATE job_attempts SET execution_contract_version = 2 WHERE id = ?1",
      )
        .bind(ATTEMPT_ID)
        .run(),
    ).rejects.toThrow();
  });

  it("fails closed on a drifted provider aggregate", async () => {
    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE provider_executions SET status = 'RUNNING' WHERE attempt_id = ?1",
    )
      .bind(ATTEMPT_ID)
      .run();

    await expect(
      createD1ProviderExecutionRepository(env.SCRIBE_DROP_DB).findCompatibleExecution(ATTEMPT_ID),
    ).rejects.toThrow("Provider execution compatibility check failed");
  });

  it("rejects a duplicate execution aggregate for one attempt", async () => {
    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `
          INSERT INTO provider_executions (
            id, attempt_id, provider_kind, provider_policy, status, created_at, updated_at
          ) VALUES (?1, ?2, 'runpod_serverless', 'runpod_serverless_v1', 'PENDING', ?3, ?3)
        `,
      )
        .bind("01ARZ3NDEKTSV4RRFFQ69G5FAX", ATTEMPT_ID, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it("serializes cleanup claims and rejects out-of-order or stale transitions", async () => {
    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE job_attempts SET status = 'FAILED', failed_at = ?2, updated_at = ?2 WHERE id = ?1",
    )
      .bind(ATTEMPT_ID, "2026-08-11T00:01:00.000Z")
      .run();
    const repository = createD1ProviderExecutionRepository(env.SCRIBE_DROP_DB);

    await expect(
      repository.claimCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 2,
        timestamp: "2026-08-11T00:02:00.000Z",
      }),
    ).resolves.toBe(false);
    const requests = await Promise.all([
      repository.requestCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 2,
        timestamp: "2026-08-11T00:02:00.000Z",
      }),
      repository.requestCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 2,
        timestamp: "2026-08-11T00:02:00.000Z",
      }),
    ]);
    expect(requests.toSorted()).toEqual([false, true]);
    await expect(
      repository.claimCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 2,
        timestamp: "2026-08-11T00:03:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.claimCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 3,
        timestamp: "2026-08-11T00:03:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.completeCleanup({
        attemptId: ATTEMPT_ID,
        expectedVersion: 4,
        outcome: "SUCCEEDED",
        timestamp: "2026-08-11T00:04:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(repository.findCompatibleExecution(ATTEMPT_ID)).resolves.toMatchObject({
      cleanupStatus: "SUCCEEDED",
      status: "TERMINAL",
      version: 5,
    });
  });
});
