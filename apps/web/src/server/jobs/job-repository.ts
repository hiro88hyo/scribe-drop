import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  MAX_ORIGINAL_FILENAME_LENGTH,
  MAX_RECORDING_DURATION_SECONDS,
  allowedMediaTypeSchema,
  attemptStatusSchema,
  jobDetailSchema,
  jobOptionsSchema,
  jobStatusSchema,
  jobSummarySchema,
  outputFormatSchema,
  publicErrorCodeSchema,
  ulidSchema,
  utcDateTimeSchema,
  type AllowedMediaType,
  type JobDetail,
  type JobOptions,
  type JobStatus,
  type JobSummary,
  type ListJobsResponse,
  type OutputFormat,
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

const FIND_JOB_ARTIFACTS_SQL = `
  SELECT
    job_artifacts.format,
    job_artifacts.size_bytes
  FROM job_artifacts
  INNER JOIN jobs ON jobs.id = job_artifacts.job_id
  WHERE jobs.owner_sub = ?1
    AND jobs.id = ?2
    AND jobs.status = 'COMPLETED'
    AND jobs.deleted_at IS NULL
    AND jobs.active_attempt_id = job_artifacts.attempt_id
  ORDER BY job_artifacts.format
`;

const FIND_ARTIFACT_DOWNLOAD_SQL = `
  SELECT
    job_artifacts.format,
    job_artifacts.object_key,
    job_artifacts.size_bytes
  FROM job_artifacts
  INNER JOIN jobs ON jobs.id = job_artifacts.job_id
  WHERE jobs.owner_sub = ?1
    AND jobs.id = ?2
    AND jobs.status = 'COMPLETED'
    AND jobs.deleted_at IS NULL
    AND jobs.active_attempt_id = job_artifacts.attempt_id
    AND job_artifacts.format = ?3
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

const FIND_UPLOAD_TARGET_SQL = `
  SELECT
    id,
    active_attempt_id,
    source_bucket,
    source_key,
    expected_size_bytes,
    actual_size_bytes,
    source_etag,
    status,
    version
  FROM jobs
  WHERE owner_sub = ?1
    AND id = ?2
    AND deleted_at IS NULL
  LIMIT 1
`;

const COMPLETE_UPLOAD_SQL = `
  UPDATE jobs
  SET
    status = 'UPLOADED',
    actual_size_bytes = ?5,
    source_etag = ?6,
    uploaded_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND version = ?4
    AND expected_size_bytes = ?5
    AND source_bucket = ?7
    AND source_key = ?8
    AND source_etag IS NULL
    AND status IN ('CREATED', 'UPLOADING')
    AND deleted_at IS NULL
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const MARK_SOURCE_MUTATED_SQL = `
  UPDATE jobs
  SET
    status = 'SOURCE_MUTATED',
    error_code = 'SOURCE_ETAG_CHANGED',
    error_message = NULL,
    failed_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND version = ?5
    AND source_etag IS NOT NULL
    AND source_etag <> ?4
    AND status IN (
      'CREATED',
      'UPLOADING',
      'UPLOADED',
      'SUBMISSION_PENDING',
      'SUBMITTING',
      'RUNNING',
      'CANCEL_REQUESTED'
    )
    AND deleted_at IS NULL
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const FAIL_ACTIVE_ATTEMPT_SOURCE_MUTATED_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    error_code = 'SOURCE_ETAG_CHANGED',
    error_message = NULL,
    heartbeat_revoked_at = CASE
      WHEN heartbeat_token_hash IS NULL THEN NULL
      ELSE ?4
    END,
    failed_at = ?4,
    updated_at = ?4
  WHERE id = ?3
    AND job_id = ?1
    AND status IN (
      'SUBMISSION_PENDING',
      'SUBMITTING',
      'RUNNING',
      'CANCEL_REQUESTED'
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?1
        AND owner_sub = ?2
        AND version = ?6
        AND active_attempt_id = ?3
        AND source_etag IS NOT NULL
        AND source_etag <> ?5
        AND status IN (
          'SUBMISSION_PENDING',
          'SUBMITTING',
          'RUNNING',
          'CANCEL_REQUESTED'
        )
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const RECORD_SOURCE_MUTATED_EVENT_SQL = `
  INSERT INTO job_events (
    id,
    job_id,
    attempt_id,
    event_type,
    actor,
    metadata_json,
    created_at
  )
  SELECT
    ?1,
    ?2,
    active_attempt_id,
    'source_mutated',
    'web',
    NULL,
    ?3
  FROM jobs
  WHERE id = ?2
    AND owner_sub = ?4
    AND status = 'SOURCE_MUTATED'
    AND error_code = 'SOURCE_ETAG_CHANGED'
    AND updated_at = ?3
  ON CONFLICT DO NOTHING
  RETURNING id
`;

const INSERT_RETRY_ATTEMPT_SQL = `
  INSERT INTO job_attempts (
    id,
    job_id,
    generation,
    status,
    result_prefix,
    created_at,
    updated_at
  )
  SELECT
    ?1,
    jobs.id,
    active_attempt.generation + 1,
    'SUBMISSION_PENDING',
    ?4,
    ?5,
    ?5
  FROM jobs
  INNER JOIN job_attempts AS active_attempt ON active_attempt.id = jobs.active_attempt_id
  WHERE jobs.id = ?2
    AND jobs.owner_sub = ?3
    AND jobs.status = 'FAILED'
    AND jobs.deleted_at IS NULL
    AND active_attempt.job_id = jobs.id
    AND active_attempt.status = 'FAILED'
    AND NOT EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?1
        OR (
          job_id = jobs.id
          AND generation = active_attempt.generation + 1
        )
    )
  RETURNING id, job_id, generation
`;

const ACTIVATE_RETRY_ATTEMPT_SQL = `
  UPDATE jobs
  SET
    status = 'SUBMISSION_PENDING',
    active_attempt_id = ?3,
    error_code = NULL,
    error_message = NULL,
    duration_seconds = NULL,
    processing_started_at = NULL,
    completed_at = NULL,
    failed_at = NULL,
    cancelled_at = NULL,
    notified_at = NULL,
    updated_at = ?4,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND status = 'FAILED'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?3
        AND job_id = ?1
        AND status = 'SUBMISSION_PENDING'
        AND created_at = ?4
    )
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const RECORD_RETRY_EVENT_SQL = `
  INSERT INTO job_events (
    id,
    job_id,
    attempt_id,
    event_type,
    actor,
    metadata_json,
    created_at
  )
  SELECT
    ?1,
    ?2,
    ?3,
    'job_retry_requested',
    'user',
    NULL,
    ?4
  FROM jobs
  WHERE id = ?2
    AND active_attempt_id = ?3
    AND status = 'SUBMISSION_PENDING'
    AND updated_at = ?4
  RETURNING id
`;

const FIND_OWNER_JOB_STATUS_SQL = `
  SELECT status
  FROM jobs
  WHERE owner_sub = ?1
    AND id = ?2
    AND deleted_at IS NULL
  LIMIT 1
`;

const FIND_CANCELLATION_CONTEXT_SQL = `
  SELECT
    jobs.id,
    jobs.title,
    jobs.original_filename,
    jobs.source_content_type,
    jobs.expected_size_bytes,
    jobs.actual_size_bytes,
    jobs.status,
    jobs.error_code,
    jobs.duration_seconds,
    jobs.created_at,
    jobs.completed_at,
    jobs.updated_at,
    jobs.active_attempt_id,
    jobs.version,
    job_attempts.status AS attempt_status
  FROM jobs
  LEFT JOIN job_attempts ON job_attempts.id = jobs.active_attempt_id
  WHERE jobs.owner_sub = ?1
    AND jobs.id = ?2
    AND jobs.deleted_at IS NULL
  LIMIT 1
`;

const CANCEL_JOB_WITHOUT_ATTEMPT_SQL = `
  UPDATE jobs
  SET
    status = 'CANCELLED',
    error_code = NULL,
    error_message = NULL,
    cancelled_at = ?5,
    updated_at = ?5,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND version = ?3
    AND active_attempt_id IS NULL
    AND status = ?4
    AND status IN ('CREATED', 'UPLOADING', 'UPLOADED')
    AND deleted_at IS NULL
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const REQUEST_ATTEMPT_CANCELLATION_SQL = `
  UPDATE job_attempts
  SET
    status = CASE
      WHEN status = 'SUBMISSION_PENDING' THEN 'CANCELLED'
      ELSE 'CANCEL_REQUESTED'
    END,
    heartbeat_revoked_at = CASE
      WHEN status = 'RUNNING' AND heartbeat_token_hash IS NOT NULL THEN ?4
      ELSE heartbeat_revoked_at
    END,
    updated_at = ?4
  WHERE id = ?1
    AND job_id = ?2
    AND status = ?3
    AND status IN ('SUBMISSION_PENDING', 'SUBMITTING', 'RUNNING')
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = ?3
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const REQUEST_JOB_CANCELLATION_SQL = `
  UPDATE jobs
  SET
    status = CASE
      WHEN ?5 = 'SUBMISSION_PENDING' THEN 'CANCELLED'
      ELSE 'CANCEL_REQUESTED'
    END,
    error_code = NULL,
    error_message = NULL,
    cancelled_at = CASE
      WHEN ?5 = 'SUBMISSION_PENDING' THEN ?6
      ELSE cancelled_at
    END,
    updated_at = ?6,
    version = version + 1
  WHERE id = ?1
    AND owner_sub = ?2
    AND version = ?3
    AND active_attempt_id = ?4
    AND status = ?5
    AND status IN ('SUBMISSION_PENDING', 'SUBMITTING', 'RUNNING')
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?4
        AND job_id = ?1
        AND status = CASE
          WHEN ?5 = 'SUBMISSION_PENDING' THEN 'CANCELLED'
          ELSE 'CANCEL_REQUESTED'
        END
        AND updated_at = ?6
    )
  RETURNING ${JOB_SUMMARY_COLUMNS}
`;

const RECORD_CANCELLATION_EVENT_SQL = `
  INSERT INTO job_events (
    id,
    job_id,
    attempt_id,
    event_type,
    actor,
    metadata_json,
    created_at
  )
  SELECT
    ?1,
    jobs.id,
    jobs.active_attempt_id,
    'job_cancel_requested',
    'user',
    NULL,
    ?3
  FROM jobs
  WHERE jobs.id = ?2
    AND jobs.updated_at = ?3
    AND jobs.status IN ('CANCEL_REQUESTED', 'CANCELLED')
    AND jobs.owner_sub = ?4
  ON CONFLICT DO NOTHING
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
const databaseArtifactSummaryRowSchema = z
  .object({
    format: outputFormatSchema,
    size_bytes: z.number().int().min(0).max(2_147_483_648),
  })
  .strict();
const databaseArtifactDownloadRowSchema = databaseArtifactSummaryRowSchema
  .extend({
    object_key: z.string().min(1).max(1024).startsWith("results/"),
  })
  .strict();

const admissionDiagnosticSchema = z
  .object({
    active_count: z.number().int().nonnegative(),
    oldest_window_created_at: utcDateTimeSchema.nullable(),
    rolling_count: z.number().int().nonnegative(),
  })
  .strict();

const databaseUploadTargetRowSchema = z
  .object({
    active_attempt_id: ulidSchema.nullable(),
    actual_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES).nullable(),
    expected_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    id: ulidSchema,
    source_bucket: z.string().min(3).max(63),
    source_etag: z.string().min(1).max(512).nullable(),
    source_key: z.string().min(1).max(1024).startsWith("incoming/"),
    status: jobStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();

const listLimitSchema = z.number().int().min(1).max(100);
const updatedJobIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);
const updatedJobSummaryRowsSchema = z.array(databaseJobSummaryRowSchema).max(1);
const insertedRetryAttemptRowsSchema = z
  .array(
    z
      .object({
        generation: z.number().int().min(2),
        id: ulidSchema,
        job_id: ulidSchema,
      })
      .strict(),
  )
  .max(1);
const databaseJobStatusRowSchema = z.object({ status: jobStatusSchema }).strict();
const cancellationContextRowSchema = databaseJobSummaryRowSchema
  .extend({
    active_attempt_id: ulidSchema.nullable(),
    attempt_status: attemptStatusSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();
const resultPrefixSchema = z.string().min(1).max(900).startsWith("results/").endsWith("/");

type DatabaseJobSummaryRow = z.infer<typeof databaseJobSummaryRowSchema>;
type DatabaseJobDetailRow = z.infer<typeof databaseJobDetailRowSchema>;

export interface JobPreparedStatement {
  all(): Promise<{ readonly results: unknown[] }>;
  bind(...values: unknown[]): JobPreparedStatement;
  first(): Promise<unknown>;
}

export interface JobDatabaseSession {
  batch(
    statements: JobPreparedStatement[],
  ): Promise<readonly { readonly results: readonly unknown[] }[]>;
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

export interface UploadTarget {
  readonly activeAttemptId: string | null;
  readonly actualSizeBytes: number | null;
  readonly expectedSizeBytes: number;
  readonly jobId: string;
  readonly sourceBucket: string;
  readonly sourceEtag: string | null;
  readonly sourceKey: string;
  readonly status: JobStatus;
  readonly version: number;
}

export interface ArtifactDownloadTarget {
  readonly format: OutputFormat;
  readonly key: string;
  readonly sizeBytes: number;
}

export interface CompleteUploadInput {
  readonly eventId: string;
  readonly expectedVersion: number;
  readonly jobId: string;
  readonly ownerSub: string;
  readonly sizeBytes: number;
  readonly sourceBucket: string;
  readonly sourceEtag: string;
  readonly sourceKey: string;
  readonly timestamp: string;
}

export type CompleteUploadResult =
  | {
      readonly job: JobSummary;
      readonly status: "completed" | "idempotent";
    }
  | {
      readonly job: JobSummary;
      readonly status: "source_mutated";
    }
  | {
      readonly status: "invalid_state";
    }
  | {
      readonly status: "not_found";
    };

export interface RetryFailedJobInput {
  readonly attemptId: string;
  readonly eventId: string;
  readonly jobId: string;
  readonly ownerSub: string;
  readonly resultPrefix: string;
  readonly timestamp: string;
}

export type RetryFailedJobResult =
  | {
      readonly generation: number;
      readonly job: JobSummary;
      readonly status: "retried";
    }
  | {
      readonly status: "invalid_state";
    }
  | {
      readonly status: "not_found";
    };

export interface RequestJobCancellationInput {
  readonly eventId: string;
  readonly jobId: string;
  readonly ownerSub: string;
  readonly timestamp: string;
}

export type RequestJobCancellationResult =
  | {
      readonly job: JobSummary;
      readonly status: "cancelled" | "idempotent" | "requested";
    }
  | {
      readonly status: "invalid_state";
    }
  | {
      readonly status: "not_found";
    };

export interface JobRepository {
  completeUpload(input: CompleteUploadInput): Promise<CompleteUploadResult>;
  create(input: NewJobRecord): Promise<CreateJobRecordResult>;
  failUploadPreparation(input: UploadPreparationTransitionInput): Promise<boolean>;
  findByOwner(ownerSub: string, jobId: string): Promise<JobDetail | undefined>;
  findUploadTargetByOwner(ownerSub: string, jobId: string): Promise<UploadTarget | undefined>;
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

function mapDetail(
  row: DatabaseJobDetailRow,
  artifacts: readonly z.infer<typeof databaseArtifactSummaryRowSchema>[],
): JobDetail {
  let untrustedOptions: unknown;
  try {
    untrustedOptions = JSON.parse(row.options_json);
  } catch {
    throw new Error("Stored job options are invalid");
  }

  return jobDetailSchema.parse({
    ...mapSummary(row),
    artifacts: artifacts.map((artifact) => ({
      format: artifact.format,
      sizeBytes: artifact.size_bytes,
    })),
    options: jobOptionsSchema.parse(untrustedOptions),
  });
}

function mapUploadTarget(row: z.infer<typeof databaseUploadTargetRowSchema>): UploadTarget {
  return {
    activeAttemptId: row.active_attempt_id,
    actualSizeBytes: row.actual_size_bytes,
    expectedSizeBytes: row.expected_size_bytes,
    jobId: row.id,
    sourceBucket: row.source_bucket,
    sourceEtag: row.source_etag,
    sourceKey: row.source_key,
    status: row.status,
    version: row.version,
  };
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

export async function retryFailedJob(
  database: D1Database,
  input: RetryFailedJobInput,
): Promise<RetryFailedJobResult> {
  const attemptId = ulidSchema.parse(input.attemptId);
  const eventId = ulidSchema.parse(input.eventId);
  const jobId = ulidSchema.parse(input.jobId);
  const ownerSub = z.string().min(1).max(512).parse(input.ownerSub);
  const resultPrefix = resultPrefixSchema.parse(input.resultPrefix);
  const resultPrefixParts = resultPrefix.split("/");
  if (
    resultPrefixParts.length !== 5 ||
    resultPrefixParts[0] !== "results" ||
    !/^[0-9a-f]{32}$/u.test(resultPrefixParts[1] ?? "") ||
    resultPrefixParts[2] !== jobId ||
    resultPrefixParts[3] !== attemptId ||
    resultPrefixParts[4] !== ""
  ) {
    throw new Error("Retry result prefix does not match the job and attempt");
  }
  const timestamp = utcDateTimeSchema.parse(input.timestamp);
  const results = await database.batch([
    database
      .prepare(INSERT_RETRY_ATTEMPT_SQL)
      .bind(attemptId, jobId, ownerSub, resultPrefix, timestamp),
    database.prepare(ACTIVATE_RETRY_ATTEMPT_SQL).bind(jobId, ownerSub, attemptId, timestamp),
    database.prepare(RECORD_RETRY_EVENT_SQL).bind(eventId, jobId, attemptId, timestamp),
  ]);
  const insertedAttempt = insertedRetryAttemptRowsSchema.parse(results[0]?.results ?? [])[0];
  const updatedJob = updatedJobSummaryRowsSchema.parse(results[1]?.results ?? [])[0];
  const insertedEvent = updatedJobIdRowsSchema.parse(results[2]?.results ?? [])[0];
  if (insertedAttempt !== undefined && updatedJob !== undefined && insertedEvent !== undefined) {
    return {
      generation: insertedAttempt.generation,
      job: mapSummary(updatedJob),
      status: "retried",
    };
  }
  if (insertedAttempt !== undefined || updatedJob !== undefined || insertedEvent !== undefined) {
    throw new Error("Retry transition was only partially persisted");
  }

  const untrustedCurrent = await database
    .withSession("first-primary")
    .prepare(FIND_OWNER_JOB_STATUS_SQL)
    .bind(ownerSub, jobId)
    .first();
  if (untrustedCurrent === null) {
    return { status: "not_found" };
  }
  databaseJobStatusRowSchema.parse(untrustedCurrent);
  return { status: "invalid_state" };
}

export async function requestJobCancellation(
  database: D1Database,
  input: RequestJobCancellationInput,
): Promise<RequestJobCancellationResult> {
  const eventId = ulidSchema.parse(input.eventId);
  const jobId = ulidSchema.parse(input.jobId);
  const ownerSub = z.string().min(1).max(512).parse(input.ownerSub);
  const timestamp = utcDateTimeSchema.parse(input.timestamp);
  const untrustedContext = await database
    .withSession("first-primary")
    .prepare(FIND_CANCELLATION_CONTEXT_SQL)
    .bind(ownerSub, jobId)
    .first();
  if (untrustedContext === null) {
    return { status: "not_found" };
  }
  const context = cancellationContextRowSchema.parse(untrustedContext);
  if (context.status === "CANCELLED" || context.status === "CANCEL_REQUESTED") {
    return {
      job: mapSummary(context),
      status: "idempotent",
    };
  }

  let statements: D1PreparedStatement[];
  if (context.active_attempt_id === null) {
    if (!["CREATED", "UPLOADING", "UPLOADED"].includes(context.status)) {
      return { status: "invalid_state" };
    }
    statements = [
      database
        .prepare(CANCEL_JOB_WITHOUT_ATTEMPT_SQL)
        .bind(jobId, ownerSub, context.version, context.status, timestamp),
      database.prepare(RECORD_CANCELLATION_EVENT_SQL).bind(eventId, jobId, timestamp, ownerSub),
    ];
  } else {
    if (
      context.attempt_status === null ||
      context.attempt_status !== context.status ||
      !["SUBMISSION_PENDING", "SUBMITTING", "RUNNING"].includes(context.status)
    ) {
      return { status: "invalid_state" };
    }
    statements = [
      database
        .prepare(REQUEST_ATTEMPT_CANCELLATION_SQL)
        .bind(context.active_attempt_id, jobId, context.status, timestamp),
      database
        .prepare(REQUEST_JOB_CANCELLATION_SQL)
        .bind(
          jobId,
          ownerSub,
          context.version,
          context.active_attempt_id,
          context.status,
          timestamp,
        ),
      database.prepare(RECORD_CANCELLATION_EVENT_SQL).bind(eventId, jobId, timestamp, ownerSub),
    ];
  }

  const results = await database.batch(statements);
  const jobResultIndex = context.active_attempt_id === null ? 0 : 1;
  const eventResultIndex = context.active_attempt_id === null ? 1 : 2;
  const updatedJob = updatedJobSummaryRowsSchema.parse(results[jobResultIndex]?.results ?? [])[0];
  const insertedEvent = updatedJobIdRowsSchema.parse(results[eventResultIndex]?.results ?? [])[0];
  if (updatedJob !== undefined && insertedEvent !== undefined) {
    return {
      job: mapSummary(updatedJob),
      status: updatedJob.status === "CANCELLED" ? "cancelled" : "requested",
    };
  }
  if (updatedJob !== undefined || insertedEvent !== undefined) {
    throw new Error("Cancellation transition was only partially persisted");
  }
  return { status: "invalid_state" };
}

export async function findArtifactDownloadByOwner(
  database: D1Database,
  ownerSub: string,
  jobId: string,
  format: OutputFormat,
): Promise<ArtifactDownloadTarget | undefined> {
  const untrusted = await database
    .withSession("first-primary")
    .prepare(FIND_ARTIFACT_DOWNLOAD_SQL)
    .bind(
      z.string().min(1).max(512).parse(ownerSub),
      ulidSchema.parse(jobId),
      outputFormatSchema.parse(format),
    )
    .first();
  if (untrusted === null) {
    return undefined;
  }
  const row = databaseArtifactDownloadRowSchema.parse(untrusted);
  return {
    format: row.format,
    key: row.object_key,
    sizeBytes: row.size_bytes,
  };
}

export function createD1JobRepository(database: JobDatabase): JobRepository {
  return {
    async completeUpload(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const sourceEtag = z.string().min(1).max(512).parse(input.sourceEtag);
      const sizeBytes = z.number().int().positive().max(MAX_FILE_SIZE_BYTES).parse(input.sizeBytes);
      const session = database.withSession("first-primary");
      const completion = await session
        .prepare(COMPLETE_UPLOAD_SQL)
        .bind(
          input.jobId,
          input.ownerSub,
          timestamp,
          input.expectedVersion,
          sizeBytes,
          sourceEtag,
          input.sourceBucket,
          input.sourceKey,
        )
        .all();
      const completedRows = updatedJobSummaryRowsSchema.parse(completion.results);
      const completed = completedRows[0];
      if (completed !== undefined) {
        return {
          job: mapSummary(completed),
          status: "completed",
        };
      }

      const untrustedCurrent = await session
        .prepare(FIND_UPLOAD_TARGET_SQL)
        .bind(input.ownerSub, input.jobId)
        .first();
      if (untrustedCurrent === null) {
        return { status: "not_found" };
      }
      const current = mapUploadTarget(databaseUploadTargetRowSchema.parse(untrustedCurrent));
      if (current.sourceBucket !== input.sourceBucket || current.sourceKey !== input.sourceKey) {
        return { status: "invalid_state" };
      }
      if (
        current.sourceEtag === sourceEtag &&
        current.actualSizeBytes === sizeBytes &&
        current.status !== "SOURCE_MUTATED"
      ) {
        const currentJob = await session
          .prepare(FIND_JOB_SQL)
          .bind(input.ownerSub, input.jobId)
          .first();
        if (currentJob === null) {
          return { status: "not_found" };
        }
        const currentRow = databaseJobDetailRowSchema.parse(currentJob);
        return {
          job: mapSummary(currentRow),
          status: "idempotent",
        };
      }
      if (current.sourceEtag === null || current.sourceEtag === sourceEtag) {
        return { status: "invalid_state" };
      }
      if (current.version !== input.expectedVersion) {
        return { status: "invalid_state" };
      }

      const results = await session.batch([
        session
          .prepare(FAIL_ACTIVE_ATTEMPT_SOURCE_MUTATED_SQL)
          .bind(
            input.jobId,
            input.ownerSub,
            current.activeAttemptId,
            timestamp,
            sourceEtag,
            input.expectedVersion,
          ),
        session
          .prepare(MARK_SOURCE_MUTATED_SQL)
          .bind(input.jobId, input.ownerSub, timestamp, sourceEtag, input.expectedVersion),
        session
          .prepare(RECORD_SOURCE_MUTATED_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), input.jobId, timestamp, input.ownerSub),
      ]);
      const updatedAttempt = updatedJobIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const mutatedRows = updatedJobSummaryRowsSchema.parse(results[1]?.results ?? []);
      const mutated = mutatedRows[0];
      if (mutated === undefined) {
        const insertedEvent = updatedJobIdRowsSchema.parse(results[2]?.results ?? [])[0];
        if (updatedAttempt !== undefined || insertedEvent !== undefined) {
          throw new Error("Source mutation transition was only partially persisted");
        }
        return { status: "invalid_state" };
      }
      const insertedEvent = updatedJobIdRowsSchema.parse(results[2]?.results ?? [])[0];
      if (
        insertedEvent === undefined ||
        (current.activeAttemptId !== null &&
          ["SUBMISSION_PENDING", "SUBMITTING", "RUNNING", "CANCEL_REQUESTED"].includes(
            current.status,
          ) &&
          updatedAttempt === undefined)
      ) {
        throw new Error("Source mutation transition was only partially persisted");
      }
      return {
        job: mapSummary(mutated),
        status: "source_mutated",
      };
    },

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
      const artifactResult = await session
        .prepare(FIND_JOB_ARTIFACTS_SQL)
        .bind(ownerSub, jobId)
        .all();
      const artifacts = z
        .array(databaseArtifactSummaryRowSchema)
        .max(3)
        .parse(artifactResult.results);
      return mapDetail(databaseJobDetailRowSchema.parse(untrustedRow), artifacts);
    },

    async findUploadTargetByOwner(ownerSub, jobId) {
      const untrustedRow = await database
        .withSession("first-primary")
        .prepare(FIND_UPLOAD_TARGET_SQL)
        .bind(ownerSub, jobId)
        .first();
      if (untrustedRow === null) {
        return undefined;
      }
      return mapUploadTarget(databaseUploadTargetRowSchema.parse(untrustedRow));
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
