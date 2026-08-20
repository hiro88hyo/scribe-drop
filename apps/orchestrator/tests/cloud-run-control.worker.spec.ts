import type { CloudRunControllerRequest, CloudRunControllerResponse } from "@scribe-drop/contracts";
import { createStructuredLogger } from "@scribe-drop/observability";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createD1CloudRunControlRepository } from "../src/cloud-run-control-repository.js";
import { reconcileCloudRunJobs } from "../src/cloud-run-reconciliation-service.js";

const NOW = "2026-08-13T00:00:00.000Z";
const FINISHED = "2026-08-13T00:00:01.000Z";
const RECONCILED = "2026-08-13T00:00:02.000Z";
const TERMINAL = "2026-08-13T00:00:03.000Z";
const CLEANED = "2026-08-13T00:00:04.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const HANDLE = "h".repeat(43);

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs;");
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO jobs (
        id, owner_sub, owner_email, title, original_filename, source_bucket, source_key,
        source_content_type, expected_size_bytes, actual_size_bytes, source_etag, status,
        options_json, created_at, uploaded_at, updated_at
      ) VALUES (
        ?1, 'owner-sub', 'owner@example.invalid', 'Cloud Run', 'source.m4a',
        'recording-transcriber-test', ?2, 'audio/mp4', 1024, 1024, 'etag',
        'SUBMISSION_PENDING', ?3, ?4, ?4, ?4
      )
    `,
  )
    .bind(
      JOB_ID,
      `incoming/${"a".repeat(32)}/${JOB_ID}/${"n".repeat(22)}/source.m4a`,
      '{"language":"auto","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
      NOW,
    )
    .run();
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO job_attempts (
        id, job_id, generation, status, result_prefix, provider_kind, provider_policy,
        execution_contract_version, execution_options_json, created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, 'SUBMISSION_PENDING', ?3, 'cloud_run_jobs',
        'cloud_run_jobs_l4_v1', 2, ?4, ?5, ?5
      )
    `,
  )
    .bind(
      ATTEMPT_ID,
      JOB_ID,
      `results/${"a".repeat(32)}/${JOB_ID}/${ATTEMPT_ID}/`,
      '{"contractVersion":2,"language":"auto","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
      NOW,
    )
    .run();
  await env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1")
    .bind(JOB_ID, ATTEMPT_ID)
    .run();
});

describe("D1 Cloud Run control repository", () => {
  it("claims one pending execution and persists the controller version", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    await expect(repository.findDispatchablePendingJobId()).resolves.toBe(JOB_ID);
    const candidate = await repository.findSubmissionCandidate(JOB_ID);
    if (candidate === undefined) throw new Error("missing Cloud Run candidate");
    await expect(
      repository.prepareSubmission({ candidate, executionHandle: HANDLE, timestamp: NOW }),
    ).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      executionHandle: HANDLE,
      jobId: JOB_ID,
      submissionStartedAt: NOW,
    });
    await expect(
      repository.recordCreateResponse({
        attemptId: ATTEMPT_ID,
        executionHandle: HANDLE,
        jobId: JOB_ID,
        response: {
          errorCode: null,
          executionHandle: HANDLE,
          outcome: "pending",
          requestId: ATTEMPT_ID,
          schemaVersion: 1,
          version: 3,
        },
        timestamp: FINISHED,
      }),
    ).resolves.toBe(true);

    const row = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          attempts.status AS attempt_status,
          attempts.submission_outcome,
          executions.status AS execution_status,
          executions.create_outcome,
          executions.provider_handle,
          executions.provider_version
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(row).toEqual({
      attempt_status: "SUBMITTING",
      create_outcome: "accepted",
      execution_status: "CREATING",
      job_status: "SUBMITTING",
      provider_handle: HANDLE,
      provider_version: 3,
      submission_outcome: "accepted",
    });
  });

  it("records an unknown effect without creating another candidate", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const candidate = await repository.findSubmissionCandidate(JOB_ID);
    if (candidate === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({ candidate, executionHandle: HANDLE, timestamp: NOW });
    await expect(
      repository.recordCreateUnknown({
        attemptId: ATTEMPT_ID,
        executionHandle: HANDLE,
        jobId: JOB_ID,
        timestamp: FINISHED,
      }),
    ).resolves.toBe(true);
    await expect(repository.findSubmissionCandidate(JOB_ID)).resolves.toBeUndefined();
    await expect(repository.findReconciliationCandidates(10)).resolves.toEqual([
      expect.objectContaining({ attemptId: ATTEMPT_ID, providerVersion: 0 }),
    ]);
  });

  it("finds only the exact current Cloud Run cancellation candidate", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const candidate = await repository.findSubmissionCandidate(JOB_ID);
    if (candidate === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({ candidate, executionHandle: HANDLE, timestamp: NOW });
    await repository.recordCreateResponse({
      attemptId: ATTEMPT_ID,
      executionHandle: HANDLE,
      jobId: JOB_ID,
      response: {
        errorCode: null,
        executionHandle: HANDLE,
        outcome: "running",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 3,
      },
      timestamp: FINISHED,
    });
    await env.SCRIBE_DROP_DB.batch([
      env.SCRIBE_DROP_DB.prepare(
        "UPDATE job_attempts SET status = 'CANCEL_REQUESTED', updated_at = ?2 WHERE id = ?1 AND status = 'RUNNING'",
      ).bind(ATTEMPT_ID, RECONCILED),
      env.SCRIBE_DROP_DB.prepare(
        "UPDATE jobs SET status = 'CANCEL_REQUESTED', updated_at = ?2, version = version + 1 WHERE id = ?1 AND status = 'RUNNING'",
      ).bind(JOB_ID, RECONCILED),
    ]);

    await expect(repository.findCancellationCandidate(JOB_ID)).resolves.toEqual(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        executionStatus: "CANCEL_REQUESTED",
        jobId: JOB_ID,
        jobStatus: "CANCEL_REQUESTED",
        providerHandle: HANDLE,
        providerVersion: 3,
      }),
    );
    await expect(
      repository.findCancellationCandidate("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    ).resolves.toBeUndefined();
  });

  it("keeps a conflicting create response nonterminal for versioned recovery", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const candidate = await repository.findSubmissionCandidate(JOB_ID);
    if (candidate === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({ candidate, executionHandle: HANDLE, timestamp: NOW });
    await expect(
      repository.recordCreateResponse({
        attemptId: ATTEMPT_ID,
        executionHandle: HANDLE,
        jobId: JOB_ID,
        response: {
          errorCode: "CONFLICT",
          executionHandle: HANDLE,
          outcome: "rejected",
          requestId: ATTEMPT_ID,
          schemaVersion: 1,
          version: 4,
        },
        timestamp: FINISHED,
      }),
    ).resolves.toBe(true);
    await expect(repository.findReconciliationCandidates(10)).resolves.toEqual([
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        cleanupStatus: "NOT_REQUESTED",
        executionStatus: "CREATING",
        providerVersion: 4,
      }),
    ]);
  });

  it("returns a pre-admission capacity rejection to the dispatchable pending state", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const candidate = await repository.findSubmissionCandidate(JOB_ID);
    if (candidate === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({ candidate, executionHandle: HANDLE, timestamp: NOW });
    await expect(
      repository.recordCreateDeferred({
        attemptId: ATTEMPT_ID,
        executionHandle: HANDLE,
        jobId: JOB_ID,
        response: {
          errorCode: "BUDGET_EXHAUSTED",
          executionHandle: HANDLE,
          outcome: "rejected",
          requestId: ATTEMPT_ID,
          schemaVersion: 1,
          version: 1,
        },
        timestamp: FINISHED,
      }),
    ).resolves.toBe(true);

    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `
          SELECT jobs.status AS job_status, attempts.status AS attempt_status,
                 executions.status AS execution_status, executions.create_outcome,
                 executions.cleanup_status, executions.provider_version
          FROM jobs
          INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
          INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
          WHERE jobs.id = ?1
        `,
      )
        .bind(JOB_ID)
        .first(),
    ).resolves.toEqual({
      attempt_status: "SUBMISSION_PENDING",
      cleanup_status: "NOT_REQUESTED",
      create_outcome: null,
      execution_status: "PENDING",
      job_status: "SUBMISSION_PENDING",
      provider_version: null,
    });
    await expect(repository.findDispatchablePendingJobId()).resolves.toBe(JOB_ID);
  });

  it("reconciles versions, fails a missing runtime terminal, and records cleanup", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const submission = await repository.findSubmissionCandidate(JOB_ID);
    if (submission === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({
      candidate: submission,
      executionHandle: HANDLE,
      timestamp: NOW,
    });
    await repository.recordCreateResponse({
      attemptId: ATTEMPT_ID,
      executionHandle: HANDLE,
      jobId: JOB_ID,
      response: {
        errorCode: null,
        executionHandle: HANDLE,
        outcome: "pending",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 3,
      },
      timestamp: FINISHED,
    });
    const creating = (await repository.findReconciliationCandidates(10))[0];
    if (creating === undefined) throw new Error("missing reconciliation candidate");
    await expect(
      repository.applyControllerResponse({
        action: "reconcile",
        candidate: creating,
        response: {
          errorCode: null,
          executionHandle: HANDLE,
          outcome: "running",
          requestId: ATTEMPT_ID,
          schemaVersion: 1,
          version: 4,
        },
        timestamp: RECONCILED,
      }),
    ).resolves.toBe(true);

    const running = (await repository.findReconciliationCandidates(10))[0];
    if (running === undefined) throw new Error("missing running candidate");
    const jobBeforeStale = await env.SCRIBE_DROP_DB.prepare(
      "SELECT version FROM jobs WHERE id = ?1",
    )
      .bind(JOB_ID)
      .first<{ version: number }>();
    await repository.applyControllerResponse({
      action: "observe",
      candidate: running,
      response: {
        errorCode: "STALE_VERSION",
        executionHandle: HANDLE,
        outcome: "rejected",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 5,
      },
      timestamp: TERMINAL,
    });
    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `SELECT provider_version FROM provider_executions WHERE attempt_id = ?1`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).resolves.toEqual({ provider_version: 5 });
    await expect(
      env.SCRIBE_DROP_DB.prepare("SELECT version FROM jobs WHERE id = ?1").bind(JOB_ID).first(),
    ).resolves.toEqual(jobBeforeStale);

    const current = (await repository.findReconciliationCandidates(10))[0];
    if (current === undefined) throw new Error("missing current candidate");
    await repository.applyControllerResponse({
      action: "observe",
      candidate: current,
      response: {
        errorCode: null,
        executionHandle: HANDLE,
        outcome: "succeeded",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 6,
      },
      timestamp: TERMINAL,
    });
    const missingTerminal = (await repository.findReconciliationCandidates(10))[0];
    if (missingTerminal === undefined) throw new Error("missing terminal candidate");
    await expect(
      repository.failMissingTerminal({ candidate: missingTerminal, timestamp: CLEANED }),
    ).resolves.toBe(true);

    const cleanup = (await repository.findReconciliationCandidates(10))[0];
    if (cleanup === undefined) throw new Error("missing cleanup candidate");
    await expect(
      repository.applyControllerResponse({
        action: "cleanup",
        candidate: cleanup,
        response: {
          errorCode: null,
          executionHandle: HANDLE,
          outcome: "cleaned",
          requestId: ATTEMPT_ID,
          schemaVersion: 1,
          version: 7,
        },
        timestamp: CLEANED,
      }),
    ).resolves.toBe(true);
    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `
          SELECT jobs.status AS job_status, attempts.status AS attempt_status,
                 executions.status AS execution_status, executions.cleanup_status
          FROM jobs
          INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
          INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
          WHERE jobs.id = ?1
        `,
      )
        .bind(JOB_ID)
        .first(),
    ).resolves.toEqual({
      attempt_status: "FAILED",
      cleanup_status: "SUCCEEDED",
      execution_status: "TERMINAL",
      job_status: "FAILED",
    });
  });

  it("persists stale-version recovery and cleanup in one reconciliation sweep", async () => {
    const repository = createD1CloudRunControlRepository(env.SCRIBE_DROP_DB);
    const submission = await repository.findSubmissionCandidate(JOB_ID);
    if (submission === undefined) throw new Error("missing Cloud Run candidate");
    await repository.prepareSubmission({
      candidate: submission,
      executionHandle: HANDLE,
      timestamp: NOW,
    });
    await repository.recordCreateResponse({
      attemptId: ATTEMPT_ID,
      executionHandle: HANDLE,
      jobId: JOB_ID,
      response: {
        errorCode: null,
        executionHandle: HANDLE,
        outcome: "pending",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 3,
      },
      timestamp: FINISHED,
    });
    const creating = (await repository.findReconciliationCandidates(10))[0];
    if (creating === undefined) throw new Error("missing reconciliation candidate");
    await repository.applyControllerResponse({
      action: "reconcile",
      candidate: creating,
      response: {
        errorCode: "PROVIDER_PERMANENT",
        executionHandle: HANDLE,
        outcome: "failed",
        requestId: ATTEMPT_ID,
        schemaVersion: 1,
        version: 6,
      },
      timestamp: TERMINAL,
    });
    const requests: CloudRunControllerRequest[] = [];
    const mutate = vi
      .fn<(request: CloudRunControllerRequest) => Promise<CloudRunControllerResponse>>()
      .mockImplementation((request) => {
        requests.push(request);
        return Promise.resolve({
          errorCode: requests.length === 1 ? "STALE_VERSION" : null,
          executionHandle: request.executionHandle,
          outcome: requests.length === 1 ? "rejected" : "cleaned",
          requestId: request.requestId,
          schemaVersion: 1,
          version: requests.length === 1 ? 8 : 9,
        });
      });
    const sweepTime = new Date("2026-08-13T00:00:05.000Z");
    let randomByte = 1;

    await expect(
      reconcileCloudRunJobs(
        {
          APP_ENV: "staging",
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
          CLOUD_RUN_CONTROLLER_ORIGIN:
            "https://scribe-drop-staging-gpu-controller-123456789012.asia-southeast1.run.app",
          CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-staging.example.invalid",
          CLOUD_RUN_RUNTIME_DERIVATION_SECRET: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
          CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
          CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
          GPU_EXECUTION_POLICY: "cloud_run_jobs_l4_v1",
          R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
          R2_BUCKET_NAME: "recording-transcriber-staging",
          R2_SECRET_ACCESS_KEY: "0000000000000000",
          SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
        },
        createStructuredLogger({
          environment: "staging",
          now: () => sweepTime,
          service: "orchestrator",
          sink: () => undefined,
        }),
        {
          createController: () => ({ mutate }),
          createRepository: () => repository,
          now: () => sweepTime,
          randomBytes: (length) => new Uint8Array(length).fill(randomByte++),
        },
      ),
    ).resolves.toEqual({
      appliedCount: 2,
      deferredCount: 0,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    });
    expect(requests).toEqual([
      expect.objectContaining({ action: "cleanup", expectedVersion: 6 }),
      expect.objectContaining({ action: "cleanup", expectedVersion: 8 }),
    ]);
    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `SELECT cleanup_status, provider_version FROM provider_executions WHERE attempt_id = ?1`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).resolves.toEqual({ cleanup_status: "SUCCEEDED", provider_version: 9 });
  });

  it("marks an unsubmitted cancelled Cloud Run attempt as already cleaned", async () => {
    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE job_attempts SET status = 'CANCELLED', updated_at = ?2 WHERE id = ?1",
    )
      .bind(ATTEMPT_ID, FINISHED)
      .run();
    await expect(
      env.SCRIBE_DROP_DB.prepare(
        `SELECT status, terminal_status, cleanup_status FROM provider_executions WHERE attempt_id = ?1`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).resolves.toEqual({
      cleanup_status: "SUCCEEDED",
      status: "TERMINAL",
      terminal_status: "CANCELLED",
    });
  });
});
