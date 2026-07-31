import {
  artifactDownloadResponseSchema,
  createJobResponseSchema,
  createJobRequestSchema,
  deleteJobResponseSchema,
  jobActionResponseSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  type CreateJobRequest,
  type JobOptions,
  type JobStatus,
  type TemporaryUploadCredentials,
} from "@scribe-drop/contracts";
import {
  R2_CAPABILITY_TTL_SECONDS,
  USER_DELETION_CAPABILITY_GRACE_SECONDS,
} from "@scribe-drop/domain";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  handleCancelJob,
  handleCreateJob,
  handleDeleteJob,
  handleGetJob,
  handleGetArtifact,
  handleListJobs,
  handleRetryJob,
  handleUploadComplete,
} from "../src/server/jobs/job-handlers.js";
import {
  createD1JobRepository,
  requestJobCancellation,
  requestJobDeletion,
  retryFailedJob,
  type JobDatabase,
  type JobPreparedStatement,
  type NewJobRecord,
  type RetryFailedJobInput,
} from "../src/server/jobs/job-repository.js";
import { createUlid } from "../src/server/id/ulid.js";
import type { WebRequestData } from "../src/server/web-context.js";

const NOW = new Date("2027-01-01T00:10:00.000Z");
const OWNER_A = {
  email: "owner-a@example.test",
  sub: "owner-a-sub",
};
const OWNER_B = {
  email: "owner-b@example.test",
  sub: "owner-b-sub",
};
const REQUEST_ID = "00000000-0000-4000-8000-000000000010";
const OPTIONS = {
  language: "ja",
  model: "large-v3-turbo",
  outputFormats: ["markdown", "json", "srt"],
  vad: true,
} satisfies JobOptions;

let idSequence = 0;

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  idSequence = 0;
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs");
  const objects = await env.RECORDINGS.list();
  await Promise.all(objects.objects.map((object) => env.RECORDINGS.delete(object.key)));
});

function nextId(timestampMilliseconds = NOW.getTime()): string {
  idSequence += 1;
  const fill = idSequence % 256;
  return createUlid(timestampMilliseconds, (length) => new Uint8Array(length).fill(fill));
}

function newJob(
  owner = OWNER_A,
  timestamp = NOW,
  overrides: Partial<NewJobRecord> = {},
): NewJobRecord {
  const id = overrides.id ?? nextId(timestamp.getTime());
  return {
    expectedSizeBytes: 1024,
    id,
    options: OPTIONS,
    originalFilename: "recording.m4a",
    ownerEmail: owner.email,
    ownerSub: owner.sub,
    sourceBucket: env.R2_BUCKET_NAME,
    sourceContentType: "audio/mp4",
    sourceKey: `incoming/pending/${id}/test-nonce/source.m4a`,
    timestamp: timestamp.toISOString(),
    title: "Verification job",
    ...overrides,
  };
}

interface InsertJobOptions {
  readonly createdAt: Date;
  readonly deleted?: boolean;
  readonly id?: string;
  readonly owner?: typeof OWNER_A;
  readonly status: JobStatus;
}

async function insertJob(options: InsertJobOptions): Promise<string> {
  const owner = options.owner ?? OWNER_A;
  const id = options.id ?? nextId(options.createdAt.getTime());
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
        deleted_at,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?12)
    `,
  )
    .bind(
      id,
      owner.sub,
      owner.email,
      "Seed job",
      "seed.m4a",
      env.R2_BUCKET_NAME,
      `incoming/pending/${id}/seed-nonce/source.m4a`,
      "audio/mp4",
      1024,
      options.status,
      JSON.stringify(OPTIONS),
      options.createdAt.toISOString(),
      options.deleted === true ? options.createdAt.toISOString() : null,
    )
    .run();
  return id;
}

async function seedFailedJob(owner = OWNER_A): Promise<{
  readonly attemptId: string;
  readonly jobId: string;
}> {
  const jobId = await insertJob({
    createdAt: new Date(NOW.getTime() - 60_000),
    owner,
    status: "FAILED",
  });
  const attemptId = nextId(NOW.getTime() - 60_000);
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          result_prefix,
          failed_at,
          error_code,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 1, 'FAILED', ?3, ?4, 'PROCESSING_FAILED', ?4, ?4)
      `,
    ).bind(
      attemptId,
      jobId,
      `results/0123456789abcdef0123456789abcdef/${jobId}/${attemptId}/`,
      new Date(NOW.getTime() - 60_000).toISOString(),
    ),
    env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE jobs
        SET
          active_attempt_id = ?2,
          error_code = 'PROCESSING_FAILED',
          failed_at = ?3
        WHERE id = ?1
      `,
    ).bind(jobId, attemptId, new Date(NOW.getTime() - 60_000).toISOString()),
  ]);
  return { attemptId, jobId };
}

async function seedActiveJob(
  status: "RUNNING" | "SUBMISSION_PENDING" | "SUBMITTING",
  owner = OWNER_A,
): Promise<{
  readonly attemptId: string;
  readonly jobId: string;
}> {
  const jobId = await insertJob({
    createdAt: new Date(NOW.getTime() - 60_000),
    owner,
    status,
  });
  const attemptId = nextId(NOW.getTime() - 60_000);
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
        ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5)
      `,
    ).bind(
      attemptId,
      jobId,
      status,
      `results/0123456789abcdef0123456789abcdef/${jobId}/${attemptId}/`,
      new Date(NOW.getTime() - 60_000).toISOString(),
    ),
    env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1").bind(
      jobId,
      attemptId,
    ),
  ]);
  return { attemptId, jobId };
}

async function seedCompletedJob(owner = OWNER_A): Promise<{
  readonly attemptId: string;
  readonly jobId: string;
  readonly resultPrefix: string;
}> {
  const jobId = await insertJob({
    createdAt: new Date(NOW.getTime() - 60_000),
    owner,
    status: "COMPLETED",
  });
  const attemptId = nextId(NOW.getTime() - 60_000);
  const resultPrefix = `results/0123456789abcdef0123456789abcdef/${jobId}/${attemptId}/`;
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
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
    ).bind(attemptId, jobId, resultPrefix, NOW.toISOString()),
    env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE jobs
        SET
          active_attempt_id = ?2,
          completed_at = ?3,
          duration_seconds = 60,
          updated_at = ?3
        WHERE id = ?1
      `,
    ).bind(jobId, attemptId, NOW.toISOString()),
    ...(["markdown", "json", "srt"] as const).map((format, index) =>
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
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `,
      ).bind(
        jobId,
        attemptId,
        format,
        `${resultPrefix}transcript.${format === "markdown" ? "md" : format}`,
        index + 10,
        String(index + 1).repeat(64),
        NOW.toISOString(),
      ),
    ),
  ]);
  return { attemptId, jobId, resultPrefix };
}

function handlerEnvironment(): {
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly OWNER_HASH_HMAC_SECRET: string;
  readonly R2_PARENT_ACCESS_KEY_ID: string;
  readonly R2_PARENT_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET_NAME: string;
  readonly RECORDINGS: R2Bucket;
  readonly SCRIBE_DROP_DB: D1Database;
} {
  return {
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    OWNER_HASH_HMAC_SECRET: env.OWNER_HASH_HMAC_SECRET,
    R2_PARENT_ACCESS_KEY_ID: env.R2_PARENT_ACCESS_KEY_ID,
    R2_PARENT_SECRET_ACCESS_KEY: env.R2_PARENT_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    RECORDINGS: env.RECORDINGS,
    SCRIBE_DROP_DB: env.SCRIBE_DROP_DB,
  };
}

function requestData(owner = OWNER_A): WebRequestData {
  return {
    auth: owner,
    requestId: REQUEST_ID,
  };
}

function validCreateBody(): CreateJobRequest {
  return createJobRequestSchema.parse({
    contentType: "audio/mp4",
    filename: "recording.m4a",
    options: OPTIONS,
    sizeBytes: 1024,
    title: "Weekly meeting",
  });
}

function temporaryUploadCredentials(key: string): TemporaryUploadCredentials {
  return {
    accessKeyId: "temporary-access-key",
    bucket: env.R2_BUCKET_NAME,
    endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    expiresAt: "2027-01-01T00:25:00.000Z",
    key,
    region: "auto",
    secretAccessKey: "temporary-secret-key",
    sessionToken: "temporary-session-token",
  };
}

describe("D1 job repository", () => {
  it("creates and maps a job through one authoritative admission statement", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const result = await repository.create(newJob());

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("Expected the job to be created");
    }
    expect(result.job).toMatchObject({
      actualSizeBytes: null,
      errorCode: null,
      status: "CREATED",
      title: "Verification job",
    });

    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT owner_sub, owner_email, source_key FROM jobs WHERE id = ?1",
    )
      .bind(result.job.id)
      .first<{
        owner_email: string;
        owner_sub: string;
        source_key: string;
      }>();
    expect(stored).toEqual({
      owner_email: OWNER_A.email,
      owner_sub: OWNER_A.sub,
      source_key: `incoming/pending/${result.job.id}/test-nonce/source.m4a`,
    });
  });

  it("keeps owner filtering and stable cursor ordering inside SQL", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const oldestId = await insertJob({
      createdAt: new Date(NOW.getTime() - 3000),
      status: "COMPLETED",
    });
    const middleId = await insertJob({
      createdAt: new Date(NOW.getTime() - 2000),
      status: "FAILED",
    });
    const newestId = await insertJob({
      createdAt: new Date(NOW.getTime() - 1000),
      status: "CANCELLED",
    });
    const otherOwnerId = await insertJob({
      createdAt: NOW,
      owner: OWNER_B,
      status: "COMPLETED",
    });
    await insertJob({
      createdAt: new Date(NOW.getTime() - 500),
      deleted: true,
      status: "COMPLETED",
    });

    const firstPage = await repository.listByOwner({
      limit: 2,
      ownerSub: OWNER_A.sub,
    });
    expect(firstPage.items.map((job) => job.id)).toEqual([newestId, middleId]);
    expect(firstPage.nextCursor).not.toBeNull();

    const listResponse = listJobsResponseSchema.parse(firstPage);
    const secondPageResponse = await handleListJobs({
      data: requestData(),
      env: handlerEnvironment(),
      request: new Request(
        `https://example.test/api/jobs?limit=2&cursor=${encodeURIComponent(
          listResponse.nextCursor ?? "",
        )}`,
      ),
    });
    expect(secondPageResponse.status).toBe(200);
    const secondPage = listJobsResponseSchema.parse(await secondPageResponse.json());
    expect(secondPage.items.map((job) => job.id)).toEqual([oldestId]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(repository.findByOwner(OWNER_A.sub, otherOwnerId)).resolves.toBeUndefined();
    await expect(repository.findByOwner(OWNER_B.sub, otherOwnerId)).resolves.toMatchObject({
      artifacts: [],
      id: otherOwnerId,
      options: OPTIONS,
    });
    await expect(
      repository.listByOwner({
        limit: 100,
        ownerSub: "' OR 1=1 --",
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("counts active jobs including logically deleted rows and releases only terminal rows", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const activeIds = await Promise.all([
      insertJob({
        createdAt: new Date(NOW.getTime() - 700_000),
        status: "CREATED",
      }),
      insertJob({
        createdAt: new Date(NOW.getTime() - 700_000),
        status: "RUNNING",
      }),
      insertJob({
        createdAt: new Date(NOW.getTime() - 700_000),
        deleted: true,
        status: "CANCEL_REQUESTED",
      }),
    ]);

    await expect(repository.create(newJob())).resolves.toEqual({
      status: "too_many_active_jobs",
    });

    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE jobs SET status = 'COMPLETED', completed_at = ?1, updated_at = ?1 WHERE id = ?2",
    )
      .bind(NOW.toISOString(), activeIds[0])
      .run();
    await expect(repository.create(newJob())).resolves.toMatchObject({
      status: "created",
    });
  });

  it("counts terminal and deleted jobs in the rolling window and honors its open boundary", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    for (let index = 0; index < 10; index += 1) {
      await insertJob({
        createdAt: new Date(NOW.getTime() - 599_999 + index),
        deleted: index === 0,
        status: index % 2 === 0 ? "COMPLETED" : "FAILED",
      });
    }

    await expect(repository.create(newJob())).resolves.toEqual({
      retryAfterSeconds: 1,
      status: "rate_limited",
    });

    for (let index = 0; index < 10; index += 1) {
      await insertJob({
        createdAt: new Date(NOW.getTime() - 600_000),
        owner: OWNER_B,
        status: "COMPLETED",
      });
    }
    await expect(repository.create(newJob(OWNER_B))).resolves.toMatchObject({
      status: "created",
    });
  });

  it("admits only one concurrent request at the last active and rate slots", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    await insertJob({
      createdAt: new Date(NOW.getTime() - 700_000),
      status: "RUNNING",
    });
    await insertJob({
      createdAt: new Date(NOW.getTime() - 700_000),
      status: "UPLOADING",
    });

    const activeResults = await Promise.all([
      repository.create(newJob()),
      repository.create(newJob()),
    ]);
    expect(activeResults.map((result) => result.status).sort()).toEqual([
      "created",
      "too_many_active_jobs",
    ]);

    for (let index = 0; index < 9; index += 1) {
      await insertJob({
        createdAt: new Date(NOW.getTime() - 500_000 + index),
        owner: OWNER_B,
        status: "COMPLETED",
      });
    }
    const rateResults = await Promise.all([
      repository.create(newJob(OWNER_B)),
      repository.create(newJob(OWNER_B)),
    ]);
    expect(rateResults.map((result) => result.status).sort()).toEqual(["created", "rate_limited"]);
  });

  it("fails closed when the D1 schema is unavailable", async () => {
    const failingStatement: JobPreparedStatement = {
      all: () => Promise.reject(new Error("test-only D1 dependency failure")),
      bind: () => failingStatement,
      first: () => Promise.reject(new Error("diagnostic must not run")),
    };
    const failingDatabase: JobDatabase = {
      withSession: () => ({
        batch: () => Promise.reject(new Error("test-only D1 dependency failure")),
        prepare: () => failingStatement,
      }),
    };
    const repository = createD1JobRepository(failingDatabase);

    await expect(repository.create(newJob())).rejects.toThrow();
  });

  it("applies upload preparation transitions once with compare-and-set semantics", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const readyJob = await repository.create(newJob());
    if (readyJob.status !== "created") {
      throw new Error("Expected the ready job to be created");
    }

    await expect(
      repository.markUploadReady({
        jobId: readyJob.job.id,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
        uploadExpiresAt: "2027-01-01T00:25:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.markUploadReady({
        jobId: readyJob.job.id,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
        uploadExpiresAt: "2027-01-01T00:25:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.failUploadPreparation({
        jobId: readyJob.job.id,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(false);

    const failedJob = await repository.create(
      newJob(OWNER_B, NOW, {
        id: nextId(),
      }),
    );
    if (failedJob.status !== "created") {
      throw new Error("Expected the failed job to be created");
    }
    await expect(
      repository.failUploadPreparation({
        jobId: failedJob.job.id,
        ownerSub: OWNER_B.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.failUploadPreparation({
        jobId: failedJob.job.id,
        ownerSub: OWNER_B.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toBe(false);
  });

  it("completes upload metadata idempotently and stops on a changed ETag", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const created = await repository.create(newJob());
    if (created.status !== "created") {
      throw new Error("Expected the upload job to be created");
    }
    await repository.markUploadReady({
      jobId: created.job.id,
      ownerSub: OWNER_A.sub,
      timestamp: NOW.toISOString(),
      uploadExpiresAt: "2027-01-01T00:25:00.000Z",
    });
    const target = await repository.findUploadTargetByOwner(OWNER_A.sub, created.job.id);
    if (target === undefined) {
      throw new Error("Expected an owner-scoped upload target");
    }
    await expect(
      repository.findUploadTargetByOwner(OWNER_B.sub, created.job.id),
    ).resolves.toBeUndefined();

    const completion = {
      expectedVersion: target.version,
      eventId: nextId(),
      jobId: target.jobId,
      ownerSub: OWNER_A.sub,
      sizeBytes: target.expectedSizeBytes,
      sourceBucket: target.sourceBucket,
      sourceEtag: "original-etag",
      sourceKey: target.sourceKey,
      timestamp: NOW.toISOString(),
    } as const;
    const duplicateResults = await Promise.all([
      repository.completeUpload(completion),
      repository.completeUpload(completion),
    ]);
    expect(duplicateResults.map((result) => result.status).sort()).toEqual([
      "completed",
      "idempotent",
    ]);
    const completedJobs = duplicateResults.flatMap((result) =>
      "job" in result ? [result.job] : [],
    );
    expect(completedJobs).toHaveLength(2);
    expect(
      completedJobs.every((job) => job.actualSizeBytes === 1024 && job.status === "UPLOADED"),
    ).toBe(true);
    const completedTarget = await repository.findUploadTargetByOwner(OWNER_A.sub, created.job.id);
    if (completedTarget === undefined) {
      throw new Error("Expected the completed upload target");
    }
    await expect(
      repository.completeUpload({
        ...completion,
        sourceEtag: "stale-replacement-etag",
      }),
    ).resolves.toEqual({ status: "invalid_state" });
    await expect(
      repository.completeUpload({
        ...completion,
        expectedVersion: completedTarget.version,
        sourceEtag: "replacement-etag",
      }),
    ).resolves.toMatchObject({
      job: {
        errorCode: "SOURCE_ETAG_CHANGED",
        status: "SOURCE_MUTATED",
      },
      status: "source_mutated",
    });

    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT actual_size_bytes, source_etag, status, version FROM jobs WHERE id = ?1",
    )
      .bind(created.job.id)
      .first();
    expect(stored).toEqual({
      actual_size_bytes: 1024,
      source_etag: "original-etag",
      status: "SOURCE_MUTATED",
      version: 4,
    });
  });

  it("fails the active attempt and records an audit event on a browser-observed mutation", async () => {
    const active = await seedActiveJob("RUNNING");
    await env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE jobs
        SET
          actual_size_bytes = expected_size_bytes,
          source_etag = 'original-etag',
          uploaded_at = ?2
        WHERE id = ?1
      `,
    )
      .bind(active.jobId, NOW.toISOString())
      .run();
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const target = await repository.findUploadTargetByOwner(OWNER_A.sub, active.jobId);
    if (target === undefined) {
      throw new Error("Expected an owner-scoped upload target");
    }
    const eventId = nextId();

    await expect(
      repository.completeUpload({
        eventId,
        expectedVersion: target.version,
        jobId: target.jobId,
        ownerSub: OWNER_A.sub,
        sizeBytes: target.expectedSizeBytes,
        sourceBucket: target.sourceBucket,
        sourceEtag: "replacement-etag",
        sourceKey: target.sourceKey,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toMatchObject({
      job: {
        errorCode: "SOURCE_ETAG_CHANGED",
        status: "SOURCE_MUTATED",
      },
      status: "source_mutated",
    });

    const state = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          jobs.error_code AS job_error_code,
          attempts.status AS attempt_status,
          attempts.error_code AS attempt_error_code,
          (SELECT COUNT(*) FROM job_events WHERE job_id = jobs.id) AS events,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = jobs.id) AS outbox
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(active.jobId)
      .first();
    expect(state).toEqual({
      attempt_error_code: "SOURCE_ETAG_CHANGED",
      attempt_status: "FAILED",
      events: 1,
      job_error_code: "SOURCE_ETAG_CHANGED",
      job_status: "SOURCE_MUTATED",
      outbox: 0,
    });
    const auditEvent = await env.SCRIBE_DROP_DB.prepare(
      "SELECT id, actor, event_type, metadata_json FROM job_events WHERE job_id = ?1",
    )
      .bind(active.jobId)
      .first();
    expect(auditEvent).toEqual({
      actor: "web",
      event_type: "source_mutated",
      id: eventId,
      metadata_json: null,
    });
  });

  it("fails closed on an impossible multi-row INSERT result without running diagnostics", async () => {
    const id = nextId();
    const row = {
      actual_size_bytes: null,
      completed_at: null,
      created_at: NOW.toISOString(),
      duration_seconds: null,
      error_code: null,
      expected_size_bytes: 1024,
      id,
      original_filename: "recording.m4a",
      source_content_type: "audio/mp4",
      status: "CREATED",
      title: "Verification job",
      updated_at: NOW.toISOString(),
    };
    let diagnosticCalls = 0;
    const impossibleStatement: JobPreparedStatement = {
      all: () => Promise.resolve({ results: [row, row] }),
      bind: () => impossibleStatement,
      first: () => {
        diagnosticCalls += 1;
        return Promise.resolve(null);
      },
    };
    const impossibleDatabase: JobDatabase = {
      withSession: () => ({
        batch: () => Promise.resolve([]),
        prepare: () => impossibleStatement,
      }),
    };

    await expect(
      createD1JobRepository(impossibleDatabase).create(newJob(OWNER_A, NOW, { id })),
    ).rejects.toThrow();
    expect(diagnosticCalls).toBe(0);
  });

  it("retries a FAILED job once with a fresh generation and owner-scoped prefix", async () => {
    const seeded = await seedFailedJob();
    const firstAttemptId = nextId();
    const secondAttemptId = nextId();
    const firstEventId = nextId();
    const secondEventId = nextId();
    const makeInput = (attemptId: string, eventId: string): RetryFailedJobInput => ({
      attemptId,
      eventId,
      jobId: seeded.jobId,
      ownerSub: OWNER_A.sub,
      resultPrefix: `results/0123456789abcdef0123456789abcdef/${seeded.jobId}/${attemptId}/`,
      timestamp: NOW.toISOString(),
    });

    const results = await Promise.all([
      retryFailedJob(env.SCRIBE_DROP_DB, makeInput(firstAttemptId, firstEventId)),
      retryFailedJob(env.SCRIBE_DROP_DB, makeInput(secondAttemptId, secondEventId)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["invalid_state", "retried"]);
    const retried = results.find((result) => result.status === "retried");
    expect(retried).toMatchObject({
      generation: 2,
      job: {
        errorCode: null,
        id: seeded.jobId,
        status: "SUBMISSION_PENDING",
      },
    });

    const attempts = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          id,
          generation,
          status,
          claim_token_hash,
          result_prefix
        FROM job_attempts
        WHERE job_id = ?1
        ORDER BY generation
      `,
    )
      .bind(seeded.jobId)
      .all();
    expect(attempts.results).toHaveLength(2);
    expect(attempts.results[0]).toMatchObject({
      generation: 1,
      id: seeded.attemptId,
      status: "FAILED",
    });
    expect(attempts.results[1]).toMatchObject({
      claim_token_hash: null,
      generation: 2,
      status: "SUBMISSION_PENDING",
    });
    expect(attempts.results[1]?.["result_prefix"]).toMatch(
      new RegExp(`^results/[0-9a-f]{32}/${seeded.jobId}/[0-9A-HJKMNP-TV-Z]{26}/$`, "u"),
    );

    const job = await env.SCRIBE_DROP_DB.prepare(
      "SELECT active_attempt_id, status, error_code, failed_at, version FROM jobs WHERE id = ?1",
    )
      .bind(seeded.jobId)
      .first();
    expect(job).toMatchObject({
      active_attempt_id: attempts.results[1]?.["id"],
      error_code: null,
      failed_at: null,
      status: "SUBMISSION_PENDING",
      version: 2,
    });
    const events = await env.SCRIBE_DROP_DB.prepare(
      "SELECT event_type, actor, attempt_id FROM job_events WHERE job_id = ?1",
    )
      .bind(seeded.jobId)
      .all();
    expect(events.results).toEqual([
      {
        actor: "user",
        attempt_id: attempts.results[1]?.["id"],
        event_type: "job_retry_requested",
      },
    ]);
  });

  it("does not expose a foreign FAILED job or retry a non-FAILED job", async () => {
    const seeded = await seedFailedJob();
    const foreignAttemptId = nextId();
    await expect(
      retryFailedJob(env.SCRIBE_DROP_DB, {
        attemptId: foreignAttemptId,
        eventId: nextId(),
        jobId: seeded.jobId,
        ownerSub: OWNER_B.sub,
        resultPrefix: `results/0123456789abcdef0123456789abcdef/${seeded.jobId}/${foreignAttemptId}/`,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "not_found" });

    const pendingJobId = await insertJob({
      createdAt: NOW,
      status: "SUBMISSION_PENDING",
    });
    const pendingAttemptId = nextId();
    await expect(
      retryFailedJob(env.SCRIBE_DROP_DB, {
        attemptId: pendingAttemptId,
        eventId: nextId(),
        jobId: pendingJobId,
        ownerSub: OWNER_A.sub,
        resultPrefix: `results/0123456789abcdef0123456789abcdef/${pendingJobId}/${pendingAttemptId}/`,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "invalid_state" });
  });

  it("does not retry after source retention has removed the recording", async () => {
    const seeded = await seedFailedJob();
    await env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET source_deleted_at = ?2 WHERE id = ?1")
      .bind(seeded.jobId, NOW.toISOString())
      .run();

    const attemptId = nextId();
    await expect(
      retryFailedJob(env.SCRIBE_DROP_DB, {
        attemptId,
        eventId: nextId(),
        jobId: seeded.jobId,
        ownerSub: OWNER_A.sub,
        resultPrefix: `results/0123456789abcdef0123456789abcdef/${seeded.jobId}/${attemptId}/`,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "invalid_state" });
    const attempts = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_attempts WHERE job_id = ?1",
    )
      .bind(seeded.jobId)
      .first<{ count: number }>();
    expect(attempts?.count).toBe(1);
  });

  it("cancels a pending attempt immediately and requests running cancellation once", async () => {
    const pending = await seedActiveJob("SUBMISSION_PENDING");
    const pendingResult = await requestJobCancellation(env.SCRIBE_DROP_DB, {
      eventId: nextId(),
      jobId: pending.jobId,
      ownerSub: OWNER_A.sub,
      timestamp: NOW.toISOString(),
    });
    expect(pendingResult).toMatchObject({
      job: { status: "CANCELLED" },
      status: "cancelled",
    });
    await expect(
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: pending.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toMatchObject({
      job: { status: "CANCELLED" },
      status: "idempotent",
    });

    const running = await seedActiveJob("RUNNING");
    await expect(
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: running.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toMatchObject({
      job: { status: "CANCEL_REQUESTED" },
      status: "requested",
    });
    const attempts = await env.SCRIBE_DROP_DB.prepare(
      "SELECT id, status FROM job_attempts WHERE id IN (?1, ?2) ORDER BY id",
    )
      .bind(pending.attemptId, running.attemptId)
      .all();
    expect(attempts.results).toContainEqual({
      id: pending.attemptId,
      status: "CANCELLED",
    });
    expect(attempts.results).toContainEqual({
      id: running.attemptId,
      status: "CANCEL_REQUESTED",
    });
    const events = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'job_cancel_requested'",
    ).first<{ count: number }>();
    expect(events?.count).toBe(2);
  });

  it("persists one cancellation event across concurrent requests", async () => {
    const running = await seedActiveJob("RUNNING");
    const results = await Promise.all([
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: running.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: running.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ]);

    expect(results.some((result) => result.status === "requested")).toBe(true);
    expect(
      results.every((result) =>
        ["idempotent", "invalid_state", "requested"].includes(result.status),
      ),
    ).toBe(true);
    const job = await env.SCRIBE_DROP_DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(running.jobId)
      .first();
    expect(job).toEqual({ status: "CANCEL_REQUESTED" });
    const events = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT COUNT(*) AS count
        FROM job_events
        WHERE job_id = ?1
          AND event_type = 'job_cancel_requested'
      `,
    )
      .bind(running.jobId)
      .first<{ count: number }>();
    expect(events?.count).toBe(1);
  });

  it("hides foreign cancellation targets and rejects terminal failures", async () => {
    const active = await seedActiveJob("RUNNING");
    await expect(
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: active.jobId,
        ownerSub: OWNER_B.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "not_found" });
    const failed = await seedFailedJob();
    await expect(
      requestJobCancellation(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: failed.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "invalid_state" });
  });

  it("logically deletes a terminal job once and hides it from owner queries", async () => {
    const completed = await seedCompletedJob();
    const eventId = nextId();

    await expect(
      requestJobDeletion(env.SCRIBE_DROP_DB, {
        eventId,
        jobId: completed.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "deleted" });
    await expect(
      requestJobDeletion(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: completed.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "deleted" });

    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    await expect(repository.findByOwner(OWNER_A.sub, completed.jobId)).resolves.toBeUndefined();
    await expect(
      repository.listByOwner({
        limit: 100,
        ownerSub: OWNER_A.sub,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    const stored = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          deleted_at,
          deletion_not_before,
          deletion_next_attempt_at,
          deletion_attempt_count,
          deletion_error_code,
          version
        FROM jobs
        WHERE id = ?1
      `,
    )
      .bind(completed.jobId)
      .first();
    expect(stored).toEqual({
      deleted_at: NOW.toISOString(),
      deletion_attempt_count: 0,
      deletion_error_code: null,
      deletion_next_attempt_at: NOW.toISOString(),
      deletion_not_before: NOW.toISOString(),
      version: 2,
    });
    const events = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT id, event_type, actor, metadata_json
        FROM job_events
        WHERE job_id = ?1
          AND event_type = 'job_delete_requested'
      `,
    )
      .bind(completed.jobId)
      .all();
    expect(events.results).toEqual([
      {
        actor: "user",
        event_type: "job_delete_requested",
        id: eventId,
        metadata_json: null,
      },
    ]);
  });

  it("revokes an active heartbeat and waits until its R2 capabilities expire", async () => {
    const active = await seedActiveJob("RUNNING");
    const issuedAt = new Date(NOW.getTime() - 60_000);
    await env.SCRIBE_DROP_DB.prepare(
      `
        UPDATE job_attempts
        SET
          heartbeat_token_hash = ?2,
          heartbeat_issued_at = ?3,
          heartbeat_expires_at = ?4
        WHERE id = ?1
      `,
    )
      .bind(
        active.attemptId,
        "a".repeat(64),
        issuedAt.toISOString(),
        new Date(issuedAt.getTime() + R2_CAPABILITY_TTL_SECONDS * 1_000).toISOString(),
      )
      .run();

    await expect(
      requestJobDeletion(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: active.jobId,
        ownerSub: OWNER_A.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "deleted" });

    const state = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.deleted_at,
          jobs.deletion_not_before,
          jobs.status AS job_status,
          attempts.status AS attempt_status,
          attempts.heartbeat_revoked_at
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        WHERE jobs.id = ?1
      `,
    )
      .bind(active.jobId)
      .first();
    expect(state).toEqual({
      attempt_status: "CANCEL_REQUESTED",
      deleted_at: NOW.toISOString(),
      deletion_not_before: new Date(
        issuedAt.getTime() +
          (R2_CAPABILITY_TTL_SECONDS + USER_DELETION_CAPABILITY_GRACE_SECONDS) * 1_000,
      ).toISOString(),
      heartbeat_revoked_at: NOW.toISOString(),
      job_status: "RUNNING",
    });
    await expect(
      requestJobDeletion(env.SCRIBE_DROP_DB, {
        eventId: nextId(),
        jobId: active.jobId,
        ownerSub: OWNER_B.sub,
        timestamp: NOW.toISOString(),
      }),
    ).resolves.toEqual({ status: "not_found" });
  });
});

describe("job API handlers", () => {
  it("creates metadata, lists it and returns owner-scoped detail", async () => {
    const jobId = nextId(NOW.getTime());
    const sourceKey = `incoming/0123456789abcdef0123456789abcdef/${jobId}/handler-nonce/source.m4a`;
    const createResponse = await handleCreateJob(
      {
        data: requestData(),
        env: handlerEnvironment(),
        request: new Request("https://example.test/api/jobs", {
          body: JSON.stringify(validCreateBody()),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      },
      {
        createJobId: () => jobId,
        createSourceKey: () => sourceKey,
        createTemporaryUploadCredentials: () =>
          Promise.resolve(temporaryUploadCredentials(sourceKey)),
        now: () => NOW,
      },
    );
    expect(createResponse.status).toBe(201);
    const created = createJobResponseSchema.parse(await createResponse.json());
    expect(created).toMatchObject({
      jobId,
      upload: {
        expiresAt: "2027-01-01T00:25:00.000Z",
        key: sourceKey,
      },
    });

    const storedUpload = await env.SCRIBE_DROP_DB.prepare(
      "SELECT source_key, status, upload_expires_at, version FROM jobs WHERE id = ?1",
    )
      .bind(jobId)
      .first<{
        source_key: string;
        status: string;
        upload_expires_at: string;
        version: number;
      }>();
    expect(storedUpload).toEqual({
      source_key: sourceKey,
      status: "UPLOADING",
      upload_expires_at: "2027-01-01T00:25:00.000Z",
      version: 2,
    });

    const detailResponse = await handleGetJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: jobId },
      request: new Request(`https://example.test/api/jobs/${jobId}`),
    });
    expect(detailResponse.status).toBe(200);
    expect(jobDetailSchema.parse(await detailResponse.json())).toMatchObject({
      id: jobId,
      options: OPTIONS,
      status: "UPLOADING",
    });

    const hiddenResponse = await handleGetJob({
      data: requestData(OWNER_B),
      env: handlerEnvironment(),
      params: { id: jobId },
      request: new Request(`https://example.test/api/jobs/${jobId}`),
    });
    expect(hiddenResponse.status).toBe(404);
    await expect(hiddenResponse.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "指定されたジョブは存在しません。",
        requestId: REQUEST_ID,
      },
    });
  });

  it("fails the admitted job without persisting credentials when credential signing fails", async () => {
    const jobId = nextId(NOW.getTime());
    const sourceKey = `incoming/0123456789abcdef0123456789abcdef/${jobId}/handler-nonce/source.m4a`;

    await expect(
      handleCreateJob(
        {
          data: requestData(),
          env: handlerEnvironment(),
          request: new Request("https://example.test/api/jobs", {
            body: JSON.stringify(validCreateBody()),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }),
        },
        {
          createJobId: () => jobId,
          createSourceKey: () => sourceKey,
          createTemporaryUploadCredentials: () =>
            Promise.reject(new Error("test-only credential failure")),
          now: () => NOW,
        },
      ),
    ).rejects.toThrow("Upload preparation failed");

    const stored = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          status,
          error_code,
          upload_expires_at,
          failed_at,
          version
        FROM jobs
        WHERE id = ?1
      `,
    )
      .bind(jobId)
      .first<{
        error_code: string;
        failed_at: string;
        status: string;
        upload_expires_at: string | null;
        version: number;
      }>();
    expect(stored).toEqual({
      error_code: "INTERNAL_ERROR",
      failed_at: NOW.toISOString(),
      status: "FAILED",
      upload_expires_at: null,
      version: 2,
    });

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("temporary-access-key");
    expect(serialized).not.toContain("temporary-secret-key");
    expect(serialized).not.toContain("temporary-session-token");
  });

  it("rejects invalid size, media type, options and cursor without writing a row", async () => {
    const invalidBodies = [
      { ...validCreateBody(), sizeBytes: 2 * 1024 * 1024 * 1024 + 1 },
      { ...validCreateBody(), contentType: "application/octet-stream" },
      {
        ...validCreateBody(),
        options: { ...OPTIONS, model: "unreviewed-model" },
      },
    ];
    const expected = [
      [413, "FILE_TOO_LARGE"],
      [415, "UNSUPPORTED_MEDIA_TYPE"],
      [400, "INVALID_REQUEST"],
    ] as const;

    for (const [index, body] of invalidBodies.entries()) {
      const response = await handleCreateJob({
        data: requestData(),
        env: handlerEnvironment(),
        request: new Request("https://example.test/api/jobs", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      });
      expect(response.status).toBe(expected[index]?.[0]);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: expected[index]?.[1] },
      });
    }

    const invalidCursorResponse = await handleListJobs({
      data: requestData(),
      env: handlerEnvironment(),
      request: new Request("https://example.test/api/jobs?cursor=not-a-cursor"),
    });
    expect(invalidCursorResponse.status).toBe(400);

    const count = await env.SCRIBE_DROP_DB.prepare("SELECT COUNT(*) AS count FROM jobs").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("verifies R2 HEAD and completes the same upload notification idempotently", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const created = await repository.create(newJob());
    if (created.status !== "created") {
      throw new Error("Expected the upload job to be created");
    }
    await repository.markUploadReady({
      jobId: created.job.id,
      ownerSub: OWNER_A.sub,
      timestamp: NOW.toISOString(),
      uploadExpiresAt: "2027-01-01T00:25:00.000Z",
    });
    const target = await repository.findUploadTargetByOwner(OWNER_A.sub, created.job.id);
    if (target === undefined) {
      throw new Error("Expected an upload target");
    }
    await env.RECORDINGS.put(target.sourceKey, new Uint8Array(target.expectedSizeBytes).fill(1));

    const notify = (): Promise<Response> =>
      handleUploadComplete(
        {
          data: requestData(),
          env: handlerEnvironment(),
          params: { id: created.job.id },
          request: new Request(`https://example.test/api/jobs/${created.job.id}/upload-complete`, {
            body: "{}",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }),
        },
        { now: () => NOW },
      );
    const firstResponse = await notify();
    const secondResponse = await notify();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(jobActionResponseSchema.parse(await firstResponse.json()).job).toMatchObject({
      actualSizeBytes: target.expectedSizeBytes,
      id: created.job.id,
      status: "UPLOADED",
    });
    expect(jobActionResponseSchema.parse(await secondResponse.json()).job).toMatchObject({
      id: created.job.id,
      status: "UPLOADED",
    });
    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, version FROM jobs WHERE id = ?1",
    )
      .bind(created.job.id)
      .first();
    expect(stored).toEqual({
      status: "UPLOADED",
      version: 3,
    });
  });

  it("accepts a strict retry request and hides foreign ownership", async () => {
    const seeded = await seedFailedJob();
    const attemptId = nextId();
    const response = await handleRetryJob(
      {
        data: requestData(),
        env: handlerEnvironment(),
        params: { id: seeded.jobId },
        request: new Request(`https://example.test/api/jobs/${seeded.jobId}/retry`, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      },
      {
        createAttemptId: () => attemptId,
        createEventId: () => nextId(),
        now: () => NOW,
      },
    );
    expect(response.status).toBe(200);
    expect(jobActionResponseSchema.parse(await response.json()).job).toMatchObject({
      id: seeded.jobId,
      status: "SUBMISSION_PENDING",
    });

    const stored = await env.SCRIBE_DROP_DB.prepare(
      "SELECT result_prefix FROM job_attempts WHERE id = ?1",
    )
      .bind(attemptId)
      .first<{ result_prefix: string }>();
    expect(stored?.result_prefix).toMatch(
      new RegExp(`^results/[0-9a-f]{32}/${seeded.jobId}/${attemptId}/$`, "u"),
    );
    expect(stored?.result_prefix).not.toContain(OWNER_A.sub);
    expect(stored?.result_prefix).not.toContain(OWNER_A.email);

    const foreignSeeded = await seedFailedJob(OWNER_B);
    const hiddenResponse = await handleRetryJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: foreignSeeded.jobId },
      request: new Request(`https://example.test/api/jobs/${foreignSeeded.jobId}/retry`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    });
    expect(hiddenResponse.status).toBe(404);

    const unknownFieldResponse = await handleRetryJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: seeded.jobId },
      request: new Request(`https://example.test/api/jobs/${seeded.jobId}/retry`, {
        body: '{"force":true}',
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    });
    expect(unknownFieldResponse.status).toBe(400);
  });

  it("accepts a strict owner-scoped cancellation request", async () => {
    const active = await seedActiveJob("RUNNING");
    const response = await handleCancelJob(
      {
        data: requestData(),
        env: handlerEnvironment(),
        params: { id: active.jobId },
        request: new Request(`https://example.test/api/jobs/${active.jobId}/cancel`, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      },
      {
        createEventId: () => nextId(),
        now: () => NOW,
      },
    );
    expect(response.status).toBe(200);
    expect(jobActionResponseSchema.parse(await response.json()).job).toMatchObject({
      id: active.jobId,
      status: "CANCEL_REQUESTED",
    });

    const foreign = await seedActiveJob("RUNNING", OWNER_B);
    const hiddenResponse = await handleCancelJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: foreign.jobId },
      request: new Request(`https://example.test/api/jobs/${foreign.jobId}/cancel`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    });
    expect(hiddenResponse.status).toBe(404);
  });

  it("accepts strict owner-scoped deletion and returns no job metadata", async () => {
    const completed = await seedCompletedJob();
    const response = await handleDeleteJob(
      {
        data: requestData(),
        env: handlerEnvironment(),
        params: { id: completed.jobId },
        request: new Request(`https://example.test/api/jobs/${completed.jobId}`, {
          body: "{}",
          headers: { "Content-Type": "application/json" },
          method: "DELETE",
        }),
      },
      {
        createEventId: () => nextId(),
        now: () => NOW,
      },
    );
    expect(response.status).toBe(202);
    expect(deleteJobResponseSchema.parse(await response.json())).toEqual({
      deleted: true,
    });

    const foreign = await seedCompletedJob(OWNER_B);
    const hidden = await handleDeleteJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: foreign.jobId },
      request: new Request(`https://example.test/api/jobs/${foreign.jobId}`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      }),
    });
    expect(hidden.status).toBe(404);

    const unknownField = await handleDeleteJob({
      data: requestData(),
      env: handlerEnvironment(),
      params: { id: foreign.jobId },
      request: new Request(`https://example.test/api/jobs/${foreign.jobId}`, {
        body: '{"force":true}',
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      }),
    });
    expect(unknownField.status).toBe(400);
  });

  it("returns owner-scoped artifact metadata and a five-minute download capability", async () => {
    const completed = await seedCompletedJob();
    const detail = await createD1JobRepository(env.SCRIBE_DROP_DB).findByOwner(
      OWNER_A.sub,
      completed.jobId,
    );
    expect(detail?.artifacts).toEqual([
      { format: "json", sizeBytes: 11 },
      { format: "markdown", sizeBytes: 10 },
      { format: "srt", sizeBytes: 12 },
    ]);

    let signedKey: string | undefined;
    const response = await handleGetArtifact(
      {
        data: requestData(),
        env: handlerEnvironment(),
        params: { format: "markdown", id: completed.jobId },
        request: new Request(`https://example.test/api/jobs/${completed.jobId}/artifacts/markdown`),
      },
      {
        createArtifactDownload: (input) => {
          signedKey = input.key;
          return Promise.resolve({
            expiresAt: "2027-01-01T00:15:00.000Z",
            url: "https://storage.example.test/download?signature=test-only",
          });
        },
        now: () => NOW,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(artifactDownloadResponseSchema.parse(await response.json())).toEqual({
      expiresAt: "2027-01-01T00:15:00.000Z",
      url: "https://storage.example.test/download?signature=test-only",
    });
    expect(signedKey).toBe(`${completed.resultPrefix}transcript.md`);

    const hidden = await handleGetArtifact({
      data: requestData(OWNER_B),
      env: handlerEnvironment(),
      params: { format: "markdown", id: completed.jobId },
      request: new Request(`https://example.test/api/jobs/${completed.jobId}/artifacts/markdown`),
    });
    expect(hidden.status).toBe(404);

    const active = await seedActiveJob("RUNNING");
    const notReady = await handleGetArtifact({
      data: requestData(),
      env: handlerEnvironment(),
      params: { format: "markdown", id: active.jobId },
      request: new Request(`https://example.test/api/jobs/${active.jobId}/artifacts/markdown`),
    });
    expect(notReady.status).toBe(409);
    await expect(notReady.json()).resolves.toMatchObject({
      error: { code: "ARTIFACT_NOT_READY" },
    });
  });

  it("rejects missing, wrong-sized, foreign-owner, and mutated source objects", async () => {
    const repository = createD1JobRepository(env.SCRIBE_DROP_DB);
    const created = await repository.create(newJob());
    if (created.status !== "created") {
      throw new Error("Expected the upload job to be created");
    }
    await repository.markUploadReady({
      jobId: created.job.id,
      ownerSub: OWNER_A.sub,
      timestamp: NOW.toISOString(),
      uploadExpiresAt: "2027-01-01T00:25:00.000Z",
    });
    const target = await repository.findUploadTargetByOwner(OWNER_A.sub, created.job.id);
    if (target === undefined) {
      throw new Error("Expected an upload target");
    }
    const request = (owner = OWNER_A): Promise<Response> =>
      handleUploadComplete(
        {
          data: requestData(owner),
          env: handlerEnvironment(),
          params: { id: created.job.id },
          request: new Request(`https://example.test/api/jobs/${created.job.id}/upload-complete`, {
            body: "{}",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }),
        },
        { now: () => NOW },
      );

    const missingResponse = await request();
    expect(missingResponse.status).toBe(409);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: { code: "SOURCE_NOT_FOUND" },
    });

    await env.RECORDINGS.put(
      target.sourceKey,
      new Uint8Array(target.expectedSizeBytes + 1).fill(1),
    );
    const wrongSizeResponse = await request();
    expect(wrongSizeResponse.status).toBe(409);
    await expect(wrongSizeResponse.json()).resolves.toMatchObject({
      error: { code: "SOURCE_SIZE_MISMATCH" },
    });

    await env.RECORDINGS.put(target.sourceKey, new Uint8Array(target.expectedSizeBytes).fill(1));
    const hiddenResponse = await request(OWNER_B);
    expect(hiddenResponse.status).toBe(404);

    expect((await request()).status).toBe(200);
    await env.RECORDINGS.put(target.sourceKey, new Uint8Array(target.expectedSizeBytes).fill(2));
    const mutatedResponse = await request();
    expect(mutatedResponse.status).toBe(409);
    await expect(mutatedResponse.json()).resolves.toMatchObject({
      error: { code: "SOURCE_ETAG_CHANGED" },
    });
    await expect(repository.findByOwner(OWNER_A.sub, created.job.id)).resolves.toMatchObject({
      errorCode: "SOURCE_ETAG_CHANGED",
      status: "SOURCE_MUTATED",
    });
  });
});
