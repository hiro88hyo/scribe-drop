import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { DeterministicFaultPlan, inspectStructuredLogs } from "@scribe-drop/test-support";

import { createD1CompletionRepository } from "../src/completion-repository.js";
import { reconcileRunpodCompletions } from "../src/completion-service.js";
import type { RunpodControlClient } from "../src/runpod-client.js";

const NOW = new Date("2026-07-25T01:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const NOTIFICATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const RETRY_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const RUNPOD_JOB_ID = "runpod-job-id";
const RETRY_RUNPOD_JOB_ID = "retry-runpod-job-id";
const RESULT_PREFIX = `results/0123456789abcdef0123456789abcdef/${JOB_ID}/${ATTEMPT_ID}/`;

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
  const objects = await env.RECORDINGS.list();
  await Promise.all(objects.objects.map((object) => env.RECORDINGS.delete(object.key)));
});

async function seedRunningJob(status: "CANCEL_REQUESTED" | "RUNNING" = "RUNNING"): Promise<void> {
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
          status,
          options_json,
          created_at,
          uploaded_at,
          processing_started_at,
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
          ?3,
          '{"language":"ja","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
          ?4,
          ?4,
          ?4,
          ?4
        )
      `,
    ).bind(
      JOB_ID,
      `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.m4a`,
      status,
      "2026-07-25T00:00:00.000Z",
    ),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          winning_runpod_job_id,
          result_prefix,
          submission_started_at,
          submission_outcome,
          submission_finished_at,
          claimed_at,
          created_at,
          updated_at
        ) VALUES (
          ?1,
          ?2,
          1,
          ?3,
          ?4,
          ?5,
          '2026-07-25T00:00:00.000Z',
          'accepted',
          '2026-07-25T00:00:01.000Z',
          '2026-07-25T00:00:02.000Z',
          '2026-07-25T00:00:00.000Z',
          '2026-07-25T00:00:02.000Z'
        )
      `,
    ).bind(ATTEMPT_ID, JOB_ID, status, RUNPOD_JOB_ID, RESULT_PREFIX),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO runpod_submissions (
          runpod_job_id,
          attempt_id,
          is_winner,
          source,
          created_at,
          updated_at
        ) VALUES (
          ?1,
          ?2,
          1,
          'submit_response',
          '2026-07-25T00:00:01.000Z',
          '2026-07-25T00:00:02.000Z'
        )
      `,
    ).bind(RUNPOD_JOB_ID, ATTEMPT_ID),
    env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1").bind(
      JOB_ID,
      ATTEMPT_ID,
    ),
  ]);
}

function logger(records: string[] = []): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: (record) => {
      records.push(record);
    },
  });
}

function completionClient(): RunpodControlClient {
  return {
    cancel: () => Promise.resolve({ outcome: "accepted" }),
    getStatus: () =>
      Promise.resolve({
        outcome: "found",
        response: {
          delayTime: 100,
          executionTime: 200,
          id: RUNPOD_JOB_ID,
          output: {
            attemptId: ATTEMPT_ID,
            detectedLanguage: "ja",
            durationSeconds: 60,
            jobId: JOB_ID,
            manifestWritten: true,
            schemaVersion: 1,
            segmentCount: 3,
            status: "completed",
          },
          status: "COMPLETED",
        },
      }),
  };
}

async function putCompleteArtifacts(): Promise<void> {
  const contents = {
    json: '{"segments":[]}',
    markdown: "# Transcript\n",
    srt: "1\n00:00:00,000 --> 00:00:01,000\nTest\n",
  } as const;
  const artifacts = {
    json: {
      key: `${RESULT_PREFIX}transcript.json`,
      sha256: "a".repeat(64),
      sizeBytes: new TextEncoder().encode(contents.json).byteLength,
    },
    markdown: {
      key: `${RESULT_PREFIX}transcript.md`,
      sha256: "b".repeat(64),
      sizeBytes: new TextEncoder().encode(contents.markdown).byteLength,
    },
    srt: {
      key: `${RESULT_PREFIX}transcript.srt`,
      sha256: "c".repeat(64),
      sizeBytes: new TextEncoder().encode(contents.srt).byteLength,
    },
  };
  await Promise.all([
    env.RECORDINGS.put(artifacts.markdown.key, contents.markdown),
    env.RECORDINGS.put(artifacts.json.key, contents.json),
    env.RECORDINGS.put(artifacts.srt.key, contents.srt),
  ]);
  await env.RECORDINGS.put(
    `${RESULT_PREFIX}manifest.json`,
    JSON.stringify({
      artifacts,
      attemptId: ATTEMPT_ID,
      complete: true,
      jobId: JOB_ID,
      schemaVersion: 1,
    }),
  );
}

describe("RunPod completion reconciliation", () => {
  it("persists terminal status before verifying artifacts and finalizes exactly once", async () => {
    await seedRunningJob();
    await putCompleteArtifacts();

    const run = (): ReturnType<typeof reconcileRunpodCompletions> =>
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          createNotificationId: () => NOTIFICATION_ID,
          createRunpodClient: () => completionClient(),
          now: () => NOW,
        },
      );
    await expect(run()).resolves.toEqual({
      cancelledCount: 0,
      completedCount: 1,
      failedCount: 0,
      terminalObservedCount: 1,
    });
    await expect(run()).resolves.toEqual({
      cancelledCount: 0,
      completedCount: 0,
      failedCount: 0,
      terminalObservedCount: 0,
    });

    const attempt = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          status,
          runpod_terminal_job_id,
          runpod_terminal_status,
          runpod_output_status,
          runpod_manifest_written,
          media_duration_seconds,
          runpod_execution_ms
        FROM job_attempts
        WHERE id = ?1
      `,
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(attempt).toEqual({
      media_duration_seconds: 60,
      runpod_execution_ms: 200,
      runpod_manifest_written: 1,
      runpod_output_status: "completed",
      runpod_terminal_job_id: RUNPOD_JOB_ID,
      runpod_terminal_status: "COMPLETED",
      status: "COMPLETED",
    });
    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, duration_seconds, completed_at, version FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      completed_at: NOW.toISOString(),
      duration_seconds: 60,
      status: "COMPLETED",
      version: 2,
    });
    const artifacts = await env.SCRIBE_DROP_DB.prepare(
      "SELECT format, object_key, size_bytes, sha256 FROM job_artifacts WHERE job_id = ?1 ORDER BY format",
    )
      .bind(JOB_ID)
      .all();
    expect(artifacts.results).toHaveLength(3);
    expect(artifacts.results.map((artifact) => artifact["format"])).toEqual([
      "json",
      "markdown",
      "srt",
    ]);
    const outbox = await env.SCRIBE_DROP_DB.prepare(
      "SELECT id, status, attempt_count FROM notification_outbox WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .all();
    expect(outbox.results).toEqual([
      {
        attempt_count: 0,
        id: NOTIFICATION_ID,
        status: "PENDING",
      },
    ]);
  });

  it("recovers deterministic R2 GET and HEAD failures on later Cron executions", async () => {
    await seedRunningJob();
    await putCompleteArtifacts();
    const faults = new DeterministicFaultPlan([
      {
        occurrences: [1],
        point: "r2.get",
      },
      {
        occurrences: [1],
        point: "r2.head",
      },
    ]);
    const records: string[] = [];
    const run = (): ReturnType<typeof reconcileRunpodCompletions> =>
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(records),
        {
          createEventId: () => EVENT_ID,
          createNotificationId: () => NOTIFICATION_ID,
          createRunpodClient: () => completionClient(),
          headArtifact: (bucket, key) => faults.before("r2.head", () => bucket.head(key)),
          now: () => NOW,
          readManifest: (bucket, key) =>
            faults.before("r2.get", async () => {
              const object = await bucket.get(key);
              if (object === null) {
                return null;
              }
              const parsed: unknown = JSON.parse(await object.text());
              return parsed;
            }),
        },
      );

    await expect(run()).resolves.toEqual({
      cancelledCount: 0,
      completedCount: 0,
      failedCount: 0,
      terminalObservedCount: 1,
    });
    await expect(run()).resolves.toEqual({
      cancelledCount: 0,
      completedCount: 0,
      failedCount: 0,
      terminalObservedCount: 0,
    });
    await expect(run()).resolves.toEqual({
      cancelledCount: 0,
      completedCount: 1,
      failedCount: 0,
      terminalObservedCount: 0,
    });

    const state = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          attempts.status AS attempt_status,
          (SELECT COUNT(*) FROM job_artifacts WHERE attempt_id = attempts.id) AS artifacts,
          (SELECT COUNT(*) FROM job_events WHERE attempt_id = attempts.id) AS events,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = jobs.id) AS outbox
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(state).toEqual({
      artifacts: 3,
      attempt_status: "COMPLETED",
      events: 1,
      job_status: "COMPLETED",
      outbox: 1,
    });
    expect(
      inspectStructuredLogs(records, [RESULT_PREFIX, "# Transcript", "fixture transcript"]).events,
    ).toEqual([
      "runpod_heartbeat_stale",
      "runpod_terminal_observed",
      "job.completion_deferred",
      "job.completion_deferred",
      "job.completed",
    ]);
    expect(() => {
      faults.assertExhausted();
    }).not.toThrow();
  });

  it("allows only one of two concurrent Cron executions to finalize", async () => {
    await seedRunningJob();
    await putCompleteArtifacts();
    const repository = createD1CompletionRepository(env.SCRIBE_DROP_DB);
    await expect(
      repository.recordTerminalStatus({
        attemptId: ATTEMPT_ID,
        delayTime: 100,
        executionTime: 200,
        jobId: JOB_ID,
        output: {
          attemptId: ATTEMPT_ID,
          detectedLanguage: "ja",
          durationSeconds: 60,
          jobId: JOB_ID,
          manifestWritten: true,
          schemaVersion: 1,
          segmentCount: 3,
          status: "completed",
        },
        runpodJobId: RUNPOD_JOB_ID,
        status: "COMPLETED",
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(true);
    const run = (): ReturnType<typeof reconcileRunpodCompletions> =>
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          createNotificationId: () => NOTIFICATION_ID,
          createRunpodClient: () => completionClient(),
          now: () => NOW,
        },
      );

    const results = await Promise.all([run(), run()]);
    expect(results.reduce((count, result) => count + result.completedCount, 0)).toBe(1);
    const related = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM job_artifacts WHERE attempt_id = ?1) AS artifacts,
          (SELECT COUNT(*) FROM job_events WHERE attempt_id = ?1) AS events,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = ?2) AS outbox
      `,
    )
      .bind(ATTEMPT_ID, JOB_ID)
      .first();
    expect(related).toEqual({
      artifacts: 3,
      events: 1,
      outbox: 1,
    });
  });

  it("does not complete when the manifest is missing or an artifact size differs", async () => {
    await seedRunningJob();
    const client = completionClient();

    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createRunpodClient: () => client,
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({
      completedCount: 0,
      terminalObservedCount: 1,
    });
    const job = await env.SCRIBE_DROP_DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({ status: "RUNNING" });
    const outboxCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_outbox",
    ).first<{ count: number }>();
    expect(outboxCount?.count).toBe(0);

    const afterRetention = new Date(NOW.getTime() + 31 * 60 * 1_000);
    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createRunpodClient: () => client,
          now: () => afterRetention,
        },
      ),
    ).resolves.toMatchObject({
      completedCount: 0,
      failedCount: 1,
      terminalObservedCount: 0,
    });
    const failedJob = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, error_code FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(failedJob).toEqual({
      error_code: "PROCESSING_FAILED",
      status: "FAILED",
    });
  });

  it("does not finalize against conflicting stored artifact metadata", async () => {
    await seedRunningJob();
    await putCompleteArtifacts();
    await env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_artifacts (
          job_id,
          attempt_id,
          format,
          object_key,
          size_bytes,
          sha256,
          created_at
        ) VALUES (?1, ?2, 'markdown', ?3, 1, ?4, ?5)
      `,
    )
      .bind(JOB_ID, ATTEMPT_ID, `${RESULT_PREFIX}transcript.md`, "d".repeat(64), NOW.toISOString())
      .run();

    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          createNotificationId: () => NOTIFICATION_ID,
          createRunpodClient: () => completionClient(),
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({
      completedCount: 0,
      terminalObservedCount: 1,
    });

    const job = await env.SCRIBE_DROP_DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({ status: "RUNNING" });
    const outboxCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_outbox",
    ).first<{ count: number }>();
    expect(outboxCount?.count).toBe(0);
  });

  it("rejects a known loser observed before the winner terminal result", async () => {
    await seedRunningJob();
    const repository = createD1CompletionRepository(env.SCRIBE_DROP_DB);
    await env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO runpod_submissions (
          runpod_job_id,
          attempt_id,
          is_winner,
          source,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 0, 'worker_claim', ?3, ?3)
      `,
    )
      .bind("loser-runpod-job", ATTEMPT_ID, NOW.toISOString())
      .run();
    await expect(
      repository.recordTerminalStatus({
        attemptId: ATTEMPT_ID,
        delayTime: 0,
        executionTime: 0,
        jobId: JOB_ID,
        output: null,
        runpodJobId: "loser-runpod-job",
        status: "FAILED",
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(false);

    await expect(
      reconcileRunpodCompletions(
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
            getStatus: () =>
              Promise.resolve({
                outcome: "found",
                response: {
                  id: RUNPOD_JOB_ID,
                  status: "FAILED",
                },
              }),
          }),
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({
      failedCount: 1,
      terminalObservedCount: 1,
    });
    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, error_code FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      error_code: "PROCESSING_FAILED",
      status: "FAILED",
    });
    const submissions = await env.SCRIBE_DROP_DB.prepare(
      "SELECT runpod_job_id, is_winner FROM runpod_submissions WHERE attempt_id = ?1 ORDER BY runpod_job_id",
    )
      .bind(ATTEMPT_ID)
      .all();
    expect(submissions.results).toEqual([
      {
        is_winner: 0,
        runpod_job_id: "loser-runpod-job",
      },
      {
        is_winner: 1,
        runpod_job_id: RUNPOD_JOB_ID,
      },
    ]);
  });

  it("ignores an old generation terminal result after a fresh retry becomes active", async () => {
    await seedRunningJob();
    await env.SCRIBE_DROP_DB.batch([
      env.SCRIBE_DROP_DB.prepare(
        `
          UPDATE job_attempts
          SET status = 'FAILED', failed_at = ?2, updated_at = ?2
          WHERE id = ?1
        `,
      ).bind(ATTEMPT_ID, NOW.toISOString()),
      env.SCRIBE_DROP_DB.prepare(
        `
          INSERT INTO job_attempts (
            id,
            job_id,
            generation,
            status,
            winning_runpod_job_id,
            result_prefix,
            submission_started_at,
            submission_outcome,
            submission_finished_at,
            claimed_at,
            created_at,
            updated_at
          ) VALUES (
            ?1,
            ?2,
            2,
            'RUNNING',
            ?3,
            ?4,
            ?5,
            'accepted',
            ?5,
            ?5,
            ?5,
            ?5
          )
        `,
      ).bind(
        RETRY_ATTEMPT_ID,
        JOB_ID,
        RETRY_RUNPOD_JOB_ID,
        `results/0123456789abcdef0123456789abcdef/${JOB_ID}/${RETRY_ATTEMPT_ID}/`,
        NOW.toISOString(),
      ),
      env.SCRIBE_DROP_DB.prepare(
        `
          INSERT INTO runpod_submissions (
            runpod_job_id,
            attempt_id,
            is_winner,
            source,
            created_at,
            updated_at
          ) VALUES (?1, ?2, 1, 'submit_response', ?3, ?3)
        `,
      ).bind(RETRY_RUNPOD_JOB_ID, RETRY_ATTEMPT_ID, NOW.toISOString()),
      env.SCRIBE_DROP_DB.prepare(
        `
          UPDATE jobs
          SET active_attempt_id = ?2, status = 'RUNNING', error_code = NULL, failed_at = NULL
          WHERE id = ?1
        `,
      ).bind(JOB_ID, RETRY_ATTEMPT_ID),
    ]);

    const repository = createD1CompletionRepository(env.SCRIBE_DROP_DB);
    await expect(
      repository.recordTerminalStatus({
        attemptId: ATTEMPT_ID,
        delayTime: 0,
        executionTime: 10,
        jobId: JOB_ID,
        output: {
          attemptId: ATTEMPT_ID,
          detectedLanguage: "ja",
          durationSeconds: 30,
          jobId: JOB_ID,
          manifestWritten: true,
          schemaVersion: 1,
          segmentCount: 1,
          status: "completed",
        },
        runpodJobId: RUNPOD_JOB_ID,
        status: "COMPLETED",
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(false);

    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT active_attempt_id, status FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      active_attempt_id: RETRY_ATTEMPT_ID,
      status: "RUNNING",
    });
    const attempts = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT id, generation, status, runpod_terminal_status
        FROM job_attempts
        WHERE job_id = ?1
        ORDER BY generation
      `,
    )
      .bind(JOB_ID)
      .all();
    expect(attempts.results).toEqual([
      {
        generation: 1,
        id: ATTEMPT_ID,
        runpod_terminal_status: null,
        status: "FAILED",
      },
      {
        generation: 2,
        id: RETRY_ATTEMPT_ID,
        runpod_terminal_status: null,
        status: "RUNNING",
      },
    ]);
    const related = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM job_artifacts WHERE job_id = ?1) AS artifacts,
          (SELECT COUNT(*) FROM job_events WHERE job_id = ?1) AS events,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = ?1) AS outbox
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(related).toEqual({
      artifacts: 0,
      events: 0,
      outbox: 0,
    });
  });

  it("sends cancel before polling and accepts a provider cancellation", async () => {
    await seedRunningJob("CANCEL_REQUESTED");
    const order: string[] = [];
    const cancel = vi.fn<RunpodControlClient["cancel"]>(() => {
      order.push("cancel");
      return Promise.resolve({ outcome: "accepted" });
    });
    const getStatus = vi.fn<RunpodControlClient["getStatus"]>(() => {
      order.push("status");
      return Promise.resolve({
        outcome: "found",
        response: {
          id: RUNPOD_JOB_ID,
          output: {
            attemptId: ATTEMPT_ID,
            errorCode: "CANCELLED",
            jobId: JOB_ID,
            manifestWritten: false,
            schemaVersion: 1,
            status: "cancelled",
          },
          status: "CANCELLED",
        },
      });
    });

    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createRunpodClient: () => ({ cancel, getStatus }),
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({
      cancelledCount: 1,
      terminalObservedCount: 1,
    });
    expect(order).toEqual(["cancel", "status"]);
    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, error_code, cancelled_at FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      cancelled_at: NOW.toISOString(),
      error_code: null,
      status: "CANCELLED",
    });
  });

  it("fails a job whose provider result is no longer observable after TTL and retention", async () => {
    await seedRunningJob();
    const beforeRetention = new Date("2026-07-25T08:29:59.999Z");
    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          createRunpodClient: () => ({
            cancel: () => Promise.resolve({ outcome: "accepted" }),
            getStatus: () => Promise.resolve({ outcome: "not_found" }),
          }),
          now: () => beforeRetention,
        },
      ),
    ).resolves.toMatchObject({
      failedCount: 0,
      terminalObservedCount: 0,
    });
    const activeJob = await env.SCRIBE_DROP_DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(JOB_ID)
      .first();
    expect(activeJob).toEqual({ status: "RUNNING" });

    const expiredAt = new Date("2026-07-25T09:00:00.000Z");
    await expect(
      reconcileRunpodCompletions(
        {
          RECORDINGS: env.RECORDINGS,
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        logger(),
        {
          createEventId: () => EVENT_ID,
          createRunpodClient: () => ({
            cancel: () => Promise.resolve({ outcome: "accepted" }),
            getStatus: () => Promise.resolve({ outcome: "not_found" }),
          }),
          now: () => expiredAt,
        },
      ),
    ).resolves.toMatchObject({
      failedCount: 1,
      terminalObservedCount: 0,
    });

    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, error_code, failed_at FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(job).toEqual({
      error_code: "PROCESSING_FAILED",
      failed_at: expiredAt.toISOString(),
      status: "FAILED",
    });
    const event = await env.SCRIBE_DROP_DB.prepare(
      "SELECT event_type FROM job_events WHERE job_id = ?1",
    )
      .bind(JOB_ID)
      .first();
    expect(event).toEqual({ event_type: "job_reconciliation_expired" });
  });
});
