import {
  MAX_FILE_SIZE_BYTES,
  jobStatusSchema,
  publicErrorCodeSchema,
  ulidSchema,
  utcDateTimeSchema,
  type JobStatus,
  type PublicErrorCode,
} from "@scribe-drop/contracts";
import { z } from "zod";

const FIND_SOURCE_JOB_SQL = `
  SELECT
    jobs.id,
    jobs.source_bucket,
    jobs.source_key,
    jobs.expected_size_bytes,
    jobs.actual_size_bytes,
    jobs.source_etag,
    jobs.status,
    jobs.version,
    jobs.active_attempt_id,
    generation_one.id AS generation_one_attempt_id
  FROM jobs
  LEFT JOIN job_attempts AS generation_one
    ON generation_one.job_id = jobs.id
    AND generation_one.generation = 1
  WHERE jobs.id = ?1
    AND jobs.deleted_at IS NULL
  LIMIT 1
`;

const INSERT_ATTEMPT_SQL = `
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
    ?2,
    1,
    'SUBMISSION_PENDING',
    ?3,
    ?4,
    ?4
  FROM jobs
  WHERE id = ?2
    AND version = ?5
    AND source_bucket = ?6
    AND source_key = ?7
    AND expected_size_bytes = ?8
    AND (source_etag IS NULL OR source_etag = ?9)
    AND active_attempt_id IS NULL
    AND status IN ('CREATED', 'UPLOADING', 'UPLOADED')
    AND deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE job_id = ?2
        AND generation = 1
    )
  RETURNING id
`;

const ACTIVATE_ATTEMPT_SQL = `
  UPDATE jobs
  SET
    actual_size_bytes = ?5,
    source_etag = ?6,
    status = 'SUBMISSION_PENDING',
    active_attempt_id = ?4,
    uploaded_at = COALESCE(uploaded_at, ?3),
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND version = ?2
    AND source_bucket = ?7
    AND source_key = ?8
    AND expected_size_bytes = ?5
    AND (source_etag IS NULL OR source_etag = ?6)
    AND active_attempt_id IS NULL
    AND status IN ('CREATED', 'UPLOADING', 'UPLOADED')
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?4
        AND job_id = ?1
        AND generation = 1
    )
  RETURNING id
`;

const RECORD_INGESTION_EVENT_SQL = `
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
    'source_ingested',
    'queue',
    NULL,
    ?4
  FROM jobs
  WHERE id = ?2
    AND active_attempt_id = ?3
    AND updated_at = ?4
  ON CONFLICT(id) DO NOTHING
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
    AND version = ?2
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
  RETURNING id
`;

const FAIL_SOURCE_SQL = `
  UPDATE jobs
  SET
    status = 'FAILED',
    error_code = ?4,
    error_message = NULL,
    failed_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND version = ?2
    AND active_attempt_id IS NULL
    AND status IN ('CREATED', 'UPLOADING', 'UPLOADED')
    AND deleted_at IS NULL
  RETURNING id
`;

const RECORD_REJECTION_EVENT_SQL = `
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
    NULL,
    'source_rejected',
    'queue',
    NULL,
    ?3
  FROM jobs
  WHERE id = ?2
    AND status = ?4
    AND error_code = ?5
    AND updated_at = ?3
  ON CONFLICT(id) DO NOTHING
`;

const sourceJobRowSchema = z
  .object({
    active_attempt_id: ulidSchema.nullable(),
    actual_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES).nullable(),
    expected_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    generation_one_attempt_id: ulidSchema.nullable(),
    id: ulidSchema,
    source_bucket: z.string().min(3).max(63),
    source_etag: z.string().min(1).max(512).nullable(),
    source_key: z.string().min(1).max(1024).startsWith("incoming/"),
    status: jobStatusSchema,
    version: z.number().int().positive(),
  })
  .strict();

const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);
const ownerHashSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const INITIAL_SOURCE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "CREATED",
  "UPLOADING",
  "UPLOADED",
]);

export interface SourceJob {
  readonly activeAttemptId: string | null;
  readonly actualSizeBytes: number | null;
  readonly expectedSizeBytes: number;
  readonly generationOneAttemptId: string | null;
  readonly id: string;
  readonly sourceBucket: string;
  readonly sourceEtag: string | null;
  readonly sourceKey: string;
  readonly status: JobStatus;
  readonly version: number;
}

export interface IngestSourceInput {
  readonly attemptId: string;
  readonly eventId: string;
  readonly job: SourceJob;
  readonly ownerHash: string;
  readonly sizeBytes: number;
  readonly sourceEtag: string;
  readonly timestamp: string;
}

export type IngestSourceResult = "conflict" | "duplicate" | "ignored" | "ingested";

export interface UploadIngestionRepository {
  failSource(
    job: SourceJob,
    errorCode: Extract<PublicErrorCode, "PROCESSING_FAILED" | "SOURCE_SIZE_MISMATCH">,
    eventId: string,
    timestamp: string,
  ): Promise<boolean>;
  findSourceJob(jobId: string): Promise<SourceJob | undefined>;
  ingestSource(input: IngestSourceInput): Promise<IngestSourceResult>;
  markSourceMutated(
    job: SourceJob,
    observedEtag: string,
    eventId: string,
    timestamp: string,
  ): Promise<boolean>;
}

function mapSourceJob(row: z.infer<typeof sourceJobRowSchema>): SourceJob {
  return {
    activeAttemptId: row.active_attempt_id,
    actualSizeBytes: row.actual_size_bytes,
    expectedSizeBytes: row.expected_size_bytes,
    generationOneAttemptId: row.generation_one_attempt_id,
    id: row.id,
    sourceBucket: row.source_bucket,
    sourceEtag: row.source_etag,
    sourceKey: row.source_key,
    status: row.status,
    version: row.version,
  };
}

export function createD1UploadIngestionRepository(database: D1Database): UploadIngestionRepository {
  return {
    async failSource(job, errorCode, eventId, timestamp) {
      const parsedTimestamp = utcDateTimeSchema.parse(timestamp);
      const parsedErrorCode = publicErrorCodeSchema.parse(errorCode);
      const parsedEventId = ulidSchema.parse(eventId);
      const results = await database.batch([
        database
          .prepare(FAIL_SOURCE_SQL)
          .bind(job.id, job.version, parsedTimestamp, parsedErrorCode),
        database
          .prepare(RECORD_REJECTION_EVENT_SQL)
          .bind(parsedEventId, job.id, parsedTimestamp, "FAILED", parsedErrorCode),
      ]);
      const updated = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      return updated !== undefined;
    },

    async findSourceJob(jobId) {
      const untrusted = await database
        .withSession("first-primary")
        .prepare(FIND_SOURCE_JOB_SQL)
        .bind(jobId)
        .first();
      if (untrusted === null) {
        return undefined;
      }
      return mapSourceJob(sourceJobRowSchema.parse(untrusted));
    },

    async ingestSource(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const sizeBytes = z.number().int().positive().max(MAX_FILE_SIZE_BYTES).parse(input.sizeBytes);
      const sourceEtag = z.string().min(1).max(512).parse(input.sourceEtag);
      const attemptId = input.job.generationOneAttemptId ?? ulidSchema.parse(input.attemptId);
      const eventId = ulidSchema.parse(input.eventId);
      const ownerHash = ownerHashSchema.parse(input.ownerHash);
      const resultPrefix = `results/${ownerHash}/${input.job.id}/${attemptId}/`;
      const statements: D1PreparedStatement[] = [];
      if (input.job.generationOneAttemptId === null) {
        statements.push(
          database
            .prepare(INSERT_ATTEMPT_SQL)
            .bind(
              attemptId,
              input.job.id,
              resultPrefix,
              timestamp,
              input.job.version,
              input.job.sourceBucket,
              input.job.sourceKey,
              sizeBytes,
              sourceEtag,
            ),
        );
      }
      const activationIndex = statements.length;
      statements.push(
        database
          .prepare(ACTIVATE_ATTEMPT_SQL)
          .bind(
            input.job.id,
            input.job.version,
            timestamp,
            attemptId,
            sizeBytes,
            sourceEtag,
            input.job.sourceBucket,
            input.job.sourceKey,
          ),
        database
          .prepare(RECORD_INGESTION_EVENT_SQL)
          .bind(eventId, input.job.id, attemptId, timestamp),
      );
      const results = await database.batch(statements);
      const activated = updatedIdRowsSchema.parse(results[activationIndex]?.results ?? [])[0];
      if (activated !== undefined) {
        return "ingested";
      }

      const current = await this.findSourceJob(input.job.id);
      if (
        current !== undefined &&
        current.generationOneAttemptId !== null &&
        current.activeAttemptId === current.generationOneAttemptId &&
        current.sourceEtag === sourceEtag &&
        current.actualSizeBytes === sizeBytes
      ) {
        return "duplicate";
      }
      if (current === undefined || !INITIAL_SOURCE_STATUSES.has(current.status)) {
        return "ignored";
      }
      return "conflict";
    },

    async markSourceMutated(job, observedEtag, eventId, timestamp) {
      const parsedTimestamp = utcDateTimeSchema.parse(timestamp);
      const sourceEtag = z.string().min(1).max(512).parse(observedEtag);
      const parsedEventId = ulidSchema.parse(eventId);
      const results = await database.batch([
        database
          .prepare(MARK_SOURCE_MUTATED_SQL)
          .bind(job.id, job.version, parsedTimestamp, sourceEtag),
        database
          .prepare(RECORD_REJECTION_EVENT_SQL)
          .bind(parsedEventId, job.id, parsedTimestamp, "SOURCE_MUTATED", "SOURCE_ETAG_CHANGED"),
      ]);
      const updated = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      return updated !== undefined;
    },
  };
}
