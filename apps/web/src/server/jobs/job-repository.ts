import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  MAX_ORIGINAL_FILENAME_LENGTH,
  MAX_RECORDING_DURATION_SECONDS,
  allowedMediaTypeSchema,
  jobDetailSchema,
  jobOptionsSchema,
  jobStatusSchema,
  jobSummarySchema,
  publicErrorCodeSchema,
  ulidSchema,
  utcDateTimeSchema,
  type AllowedMediaType,
  type JobDetail,
  type JobOptions,
  type JobSummary,
  type ListJobsResponse,
} from "@scribe-drop/contracts";
import {
  ACTIVE_JOB_STATUSES,
  JOB_CREATION_WINDOW_SECONDS,
  MAX_ACTIVE_JOBS_PER_OWNER,
  MAX_JOB_CREATIONS_PER_WINDOW,
} from "@scribe-drop/domain";
import { z } from "zod";

import { encodeJobCursor, type JobCursor } from "./job-cursor.js";

const JOB_SUMMARY_COLUMNS = `
  id,
  title,
  original_filename,
  source_content_type,
  expected_size_bytes,
  actual_size_bytes,
  status,
  error_code,
  duration_seconds,
  created_at,
  completed_at,
  updated_at
`;

const INSERT_ACTIVE_STATUS_PARAMETERS = ACTIVE_JOB_STATUSES.map(
  (_status, index) => `?${String(index + 15)}`,
).join(", ");
const DIAGNOSTIC_ACTIVE_STATUS_PARAMETERS = ACTIVE_JOB_STATUSES.map(
  (_status, index) => `?${String(index + 4)}`,
).join(", ");

const INSERT_JOB_SQL = `
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
  )
  SELECT
    ?1,
    ?2,
    ?3,
    ?4,
    ?5,
    ?6,
    ?7,
    ?8,
    ?9,
    'CREATED',
    ?10,
    ?11,
    ?11
  WHERE (
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = ?2
      AND created_at > ?12
      AND created_at <= ?11
  ) < ?13
  AND (
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = ?2
      AND status IN (${INSERT_ACTIVE_STATUS_PARAMETERS})
  ) < ?14
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const ADMISSION_DIAGNOSTIC_SQL = `
  SELECT
    (
      SELECT COUNT(*)
      FROM jobs
      WHERE owner_sub = ?1
        AND status IN (${DIAGNOSTIC_ACTIVE_STATUS_PARAMETERS})
    ) AS active_count,
    (
      SELECT COUNT(*)
      FROM jobs
      WHERE owner_sub = ?1
        AND created_at > ?2
        AND created_at <= ?3
    ) AS rolling_count,
    (
      SELECT MIN(created_at)
      FROM jobs
      WHERE owner_sub = ?1
        AND created_at > ?2
        AND created_at <= ?3
    ) AS oldest_window_created_at
`;

const LIST_JOBS_SQL = `
  SELECT ${JOB_SUMMARY_COLUMNS}
  FROM jobs
  WHERE owner_sub = ?1
    AND deleted_at IS NULL
  ORDER BY created_at DESC, id DESC
  LIMIT ?2
`;

const LIST_JOBS_AFTER_CURSOR_SQL = `
  SELECT ${JOB_SUMMARY_COLUMNS}
  FROM jobs
  WHERE owner_sub = ?1
    AND deleted_at IS NULL
    AND (
      created_at < ?2
      OR (created_at = ?2 AND id < ?3)
    )
  ORDER BY created_at DESC, id DESC
  LIMIT ?4
`;

const FIND_JOB_SQL = `
  SELECT
    ${JOB_SUMMARY_COLUMNS},
    options_json
  FROM jobs
  WHERE owner_sub = ?1
    AND id = ?2
    AND deleted_at IS NULL
  LIMIT 1
`;

const MARK_UPLOAD_READY_SQL = `
  UPDATE jobs
  SET
    status = 'UPLOADING',
    upload_expires_at = ?4,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND status = 'CREATED'
    AND deleted_at IS NULL
  RETURNING id
`;

const FAIL_UPLOAD_PREPARATION_SQL = `
  UPDATE jobs
  SET
    status = 'FAILED',
    error_code = 'INTERNAL_ERROR',
    error_message = NULL,
    failed_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND status = 'CREATED'
    AND deleted_at IS NULL
  RETURNING id
`;

const databaseJobSummaryRowSchema = z
  .object({
    actual_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES).nullable(),
    completed_at: utcDateTimeSchema.nullable(),
    created_at: utcDateTimeSchema,
    duration_seconds: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS).nullable(),
    error_code: publicErrorCodeSchema.nullable(),
    expected_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    id: ulidSchema,
    original_filename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_LENGTH),
    source_content_type: allowedMediaTypeSchema,
    status: jobStatusSchema,
    title: z.string().min(1).max(MAX_JOB_TITLE_LENGTH),
    updated_at: utcDateTimeSchema,
  })
  .strict();

const databaseJobDetailRowSchema = databaseJobSummaryRowSchema
  .extend({
    options_json: z.string().min(2).max(16_384),
  })
  .strict();

const admissionDiagnosticSchema = z
  .object({
    active_count: z.number().int().nonnegative(),
    oldest_window_created_at: utcDateTimeSchema.nullable(),
    rolling_count: z.number().int().nonnegative(),
  })
  .strict();

const listLimitSchema = z.number().int().min(1).max(100);
const updatedJobIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);

type DatabaseJobSummaryRow = z.infer<typeof databaseJobSummaryRowSchema>;
type DatabaseJobDetailRow = z.infer<typeof databaseJobDetailRowSchema>;

export interface JobPreparedStatement {
  all(): Promise<{ readonly results: unknown[] }>;
  bind(...values: unknown[]): JobPreparedStatement;
  first(): Promise<unknown>;
}

export interface JobDatabaseSession {
  prepare(query: string): JobPreparedStatement;
}

export interface JobDatabase {
  withSession(constraint: "first-primary" | "first-unconstrained"): JobDatabaseSession;
}

export interface NewJobRecord {
  readonly expectedSizeBytes: number;
  readonly id: string;
  readonly options: JobOptions;
  readonly originalFilename: string;
  readonly ownerEmail: string;
  readonly ownerSub: string;
  readonly sourceBucket: string;
  readonly sourceContentType: AllowedMediaType;
  readonly sourceKey: string;
  readonly timestamp: string;
  readonly title: string;
}

export type CreateJobRecordResult =
  | {
      readonly job: JobSummary;
      readonly status: "created";
    }
  | {
      readonly status: "rate_limited";
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: "too_many_active_jobs";
    };

export interface ListJobsInput {
  readonly cursor?: JobCursor;
  readonly limit: number;
  readonly ownerSub: string;
}

export interface UploadPreparationTransitionInput {
  readonly jobId: string;
  readonly ownerSub: string;
  readonly timestamp: string;
}

export interface MarkUploadReadyInput extends UploadPreparationTransitionInput {
  readonly uploadExpiresAt: string;
}

export interface JobRepository {
  create(input: NewJobRecord): Promise<CreateJobRecordResult>;
  failUploadPreparation(input: UploadPreparationTransitionInput): Promise<boolean>;
  findByOwner(ownerSub: string, jobId: string): Promise<JobDetail | undefined>;
  listByOwner(input: ListJobsInput): Promise<ListJobsResponse>;
  markUploadReady(input: MarkUploadReadyInput): Promise<boolean>;
}

function mapSummary(row: DatabaseJobSummaryRow): JobSummary {
  return jobSummarySchema.parse({
    actualSizeBytes: row.actual_size_bytes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    durationSeconds: row.duration_seconds,
    errorCode: row.error_code,
    expectedSizeBytes: row.expected_size_bytes,
    id: row.id,
    originalFilename: row.original_filename,
    sourceContentType: row.source_content_type,
    status: row.status,
    title: row.title,
    updatedAt: row.updated_at,
  });
}

function mapDetail(row: DatabaseJobDetailRow): JobDetail {
  let untrustedOptions: unknown;
  try {
    untrustedOptions = JSON.parse(row.options_json);
  } catch {
    throw new Error("Stored job options are invalid");
  }

  return jobDetailSchema.parse({
    ...mapSummary(row),
    artifacts: [],
    options: jobOptionsSchema.parse(untrustedOptions),
  });
}

function calculateRetryAfterSeconds(oldestCreatedAt: string | null, now: string): number {
  if (oldestCreatedAt === null) {
    return 60;
  }

  const oldestMilliseconds = Date.parse(oldestCreatedAt);
  const nowMilliseconds = Date.parse(now);
  if (!Number.isFinite(oldestMilliseconds) || !Number.isFinite(nowMilliseconds)) {
    return 60;
  }

  const retryAtMilliseconds =
    oldestMilliseconds + JOB_CREATION_WINDOW_SECONDS * 1000 - nowMilliseconds;
  return Math.max(1, Math.min(JOB_CREATION_WINDOW_SECONDS, Math.ceil(retryAtMilliseconds / 1000)));
}

export function createD1JobRepository(database: JobDatabase): JobRepository {
  return {
    async create(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const windowStart = new Date(
        Date.parse(timestamp) - JOB_CREATION_WINDOW_SECONDS * 1000,
      ).toISOString();
      const session = database.withSession("first-primary");
      const result = await session
        .prepare(INSERT_JOB_SQL)
        .bind(
          input.id,
          input.ownerSub,
          input.ownerEmail,
          input.title,
          input.originalFilename,
          input.sourceBucket,
          input.sourceKey,
          input.sourceContentType,
          input.expectedSizeBytes,
          JSON.stringify(input.options),
          timestamp,
          windowStart,
          MAX_JOB_CREATIONS_PER_WINDOW,
          MAX_ACTIVE_JOBS_PER_OWNER,
          ...ACTIVE_JOB_STATUSES,
        )
        .all();

      const rows = z.array(databaseJobSummaryRowSchema).max(1).parse(result.results);
      const created = rows[0];
      if (created !== undefined) {
        return {
          job: mapSummary(created),
          status: "created",
        };
      }

      const untrustedDiagnostic = await session
        .prepare(ADMISSION_DIAGNOSTIC_SQL)
        .bind(input.ownerSub, windowStart, timestamp, ...ACTIVE_JOB_STATUSES)
        .first();
      const diagnostic = admissionDiagnosticSchema.parse(untrustedDiagnostic);
      if (diagnostic.active_count >= MAX_ACTIVE_JOBS_PER_OWNER) {
        return { status: "too_many_active_jobs" };
      }
      if (diagnostic.rolling_count >= MAX_JOB_CREATIONS_PER_WINDOW) {
        return {
          retryAfterSeconds: calculateRetryAfterSeconds(
            diagnostic.oldest_window_created_at,
            timestamp,
          ),
          status: "rate_limited",
        };
      }

      return {
        retryAfterSeconds: 60,
        status: "rate_limited",
      };
    },

    async failUploadPreparation(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const result = await database
        .withSession("first-primary")
        .prepare(FAIL_UPLOAD_PREPARATION_SQL)
        .bind(input.jobId, input.ownerSub, timestamp)
        .all();
      return updatedJobIdRowsSchema.parse(result.results).length === 1;
    },

    async findByOwner(ownerSub, jobId) {
      const session = database.withSession("first-primary");
      const untrustedRow = await session.prepare(FIND_JOB_SQL).bind(ownerSub, jobId).first();
      if (untrustedRow === null) {
        return undefined;
      }
      return mapDetail(databaseJobDetailRowSchema.parse(untrustedRow));
    },

    async listByOwner(input) {
      const limit = listLimitSchema.parse(input.limit);
      const statement =
        input.cursor === undefined
          ? database
              .withSession("first-primary")
              .prepare(LIST_JOBS_SQL)
              .bind(input.ownerSub, limit + 1)
          : database
              .withSession("first-primary")
              .prepare(LIST_JOBS_AFTER_CURSOR_SQL)
              .bind(input.ownerSub, input.cursor.createdAt, input.cursor.id, limit + 1);
      const result = await statement.all();
      const rows = z
        .array(databaseJobSummaryRowSchema)
        .max(limit + 1)
        .parse(result.results);
      const hasNextPage = rows.length > limit;
      const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapSummary);
      const lastItem = items.at(-1);

      return {
        items,
        nextCursor:
          hasNextPage && lastItem !== undefined
            ? encodeJobCursor({
                createdAt: lastItem.createdAt,
                id: lastItem.id,
              })
            : null,
      };
    },

    async markUploadReady(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const uploadExpiresAt = utcDateTimeSchema.parse(input.uploadExpiresAt);
      if (Date.parse(uploadExpiresAt) <= Date.parse(timestamp)) {
        throw new Error("Upload credential expiry must be after issuance");
      }

      const result = await database
        .withSession("first-primary")
        .prepare(MARK_UPLOAD_READY_SQL)
        .bind(input.jobId, input.ownerSub, timestamp, uploadExpiresAt)
        .all();
      return updatedJobIdRowsSchema.parse(result.results).length === 1;
    },
  };
}
