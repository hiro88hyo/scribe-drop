import {
  createJobResponseSchema,
  createJobRequestSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  type CreateJobRequest,
  type JobOptions,
  type JobStatus,
  type TemporaryUploadCredentials,
} from "@scribe-drop/contracts";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleCreateJob, handleGetJob, handleListJobs } from "../src/server/jobs/job-handlers.js";
import {
  createD1JobRepository,
  type JobDatabase,
  type JobPreparedStatement,
  type NewJobRecord,
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

function handlerEnvironment(): {
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly OWNER_HASH_HMAC_SECRET: string;
  readonly R2_PARENT_ACCESS_KEY_ID: string;
  readonly R2_PARENT_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET_NAME: string;
  readonly SCRIBE_DROP_DB: D1Database;
} {
  return {
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    OWNER_HASH_HMAC_SECRET: env.OWNER_HASH_HMAC_SECRET,
    R2_PARENT_ACCESS_KEY_ID: env.R2_PARENT_ACCESS_KEY_ID,
    R2_PARENT_SECRET_ACCESS_KEY: env.R2_PARENT_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
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
        prepare: () => impossibleStatement,
      }),
    };

    await expect(
      createD1JobRepository(impossibleDatabase).create(newJob(OWNER_A, NOW, { id })),
    ).rejects.toThrow();
    expect(diagnosticCalls).toBe(0);
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
});
