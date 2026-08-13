import { attemptStatusSchema, ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { deletionNotBeforeMilliseconds } from "@scribe-drop/domain";
import { z } from "zod";

const RETENTION_LIMIT_MAX = 100;

const sourceCandidateRowSchema = z
  .object({
    id: ulidSchema,
    source_key: z.string().min(1).max(1_024).startsWith("incoming/"),
    version: z.number().int().positive(),
  })
  .strict();

const resultCandidateRowSchema = z
  .object({
    id: ulidSchema,
    job_id: ulidSchema,
    result_prefix: z.string().min(1).max(900).startsWith("results/").endsWith("/"),
    status: attemptStatusSchema,
    updated_at: utcDateTimeSchema,
  })
  .strict();

const auditCandidateRowSchema = z
  .object({
    id: ulidSchema,
    latest_capability_issued_at: utcDateTimeSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();

const mutationRowSchema = z
  .object({
    id: ulidSchema,
  })
  .strict();

const JOB_PROVIDER_COMPATIBILITY_PREDICATE = `
  (
    jobs.active_attempt_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM job_attempts AS compatibility_attempts
      LEFT JOIN provider_executions AS compatibility_executions
        ON compatibility_executions.attempt_id = compatibility_attempts.id
      WHERE compatibility_attempts.id = jobs.active_attempt_id
        AND (
          (
            compatibility_attempts.provider_kind IS NULL
            AND compatibility_executions.id IS NULL
          )
          OR (
            compatibility_attempts.provider_kind = 'runpod_serverless'
            AND compatibility_executions.id = compatibility_attempts.id
            AND compatibility_executions.provider_kind = compatibility_attempts.provider_kind
            AND compatibility_executions.provider_policy = compatibility_attempts.provider_policy
            AND compatibility_executions.status = CASE compatibility_attempts.status
              WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
              WHEN 'SUBMITTING' THEN 'CREATING'
              WHEN 'RUNNING' THEN 'RUNNING'
              WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
              ELSE 'TERMINAL'
            END
            AND compatibility_executions.create_outcome IS compatibility_attempts.submission_outcome
            AND compatibility_executions.provider_handle IS compatibility_attempts.winning_runpod_job_id
            AND compatibility_executions.terminal_status IS compatibility_attempts.runpod_terminal_status
          )
          OR (
            compatibility_attempts.provider_kind = 'cloud_run_jobs'
            AND compatibility_executions.id = compatibility_attempts.id
            AND compatibility_executions.provider_kind = compatibility_attempts.provider_kind
            AND compatibility_executions.provider_policy = compatibility_attempts.provider_policy
            AND compatibility_executions.status = 'TERMINAL'
            AND compatibility_executions.create_outcome IS compatibility_attempts.submission_outcome
            AND compatibility_executions.cleanup_status = 'SUCCEEDED'
          )
        )
    )
  )
`;

const ATTEMPT_PROVIDER_COMPATIBILITY_PREDICATE = `
  (
    (
      attempts.provider_kind IS NULL
      AND executions.id IS NULL
    )
    OR (
      attempts.provider_kind = 'runpod_serverless'
      AND executions.id = attempts.id
      AND executions.provider_kind = attempts.provider_kind
      AND executions.provider_policy = attempts.provider_policy
      AND executions.status = 'TERMINAL'
      AND executions.create_outcome IS attempts.submission_outcome
      AND executions.provider_handle IS attempts.winning_runpod_job_id
      AND executions.terminal_status IS attempts.runpod_terminal_status
    )
    OR (
      attempts.provider_kind = 'cloud_run_jobs'
      AND executions.id = attempts.id
      AND executions.provider_kind = attempts.provider_kind
      AND executions.provider_policy = attempts.provider_policy
      AND executions.status = 'TERMINAL'
      AND executions.create_outcome IS attempts.submission_outcome
      AND executions.cleanup_status = 'SUCCEEDED'
    )
  )
`;

const UPDATE_ATTEMPT_PROVIDER_COMPATIBILITY_PREDICATE = `
  (
    (
      provider_kind IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM provider_executions WHERE attempt_id = job_attempts.id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM provider_executions AS executions
      WHERE executions.attempt_id = job_attempts.id
        AND job_attempts.provider_kind = 'runpod_serverless'
        AND executions.id = job_attempts.id
        AND executions.provider_kind = job_attempts.provider_kind
        AND executions.provider_policy = job_attempts.provider_policy
        AND executions.status = 'TERMINAL'
        AND executions.create_outcome IS job_attempts.submission_outcome
        AND executions.provider_handle IS job_attempts.winning_runpod_job_id
        AND executions.terminal_status IS job_attempts.runpod_terminal_status
    )
    OR EXISTS (
      SELECT 1
      FROM provider_executions AS executions
      WHERE executions.attempt_id = job_attempts.id
        AND job_attempts.provider_kind = 'cloud_run_jobs'
        AND executions.id = job_attempts.id
        AND executions.provider_kind = job_attempts.provider_kind
        AND executions.provider_policy = job_attempts.provider_policy
        AND executions.status = 'TERMINAL'
        AND executions.create_outcome IS job_attempts.submission_outcome
        AND executions.cleanup_status = 'SUCCEEDED'
    )
  )
`;

const FIND_SOURCE_RETENTION_CANDIDATES_SQL = `
  SELECT jobs.id, jobs.source_key, jobs.version
  FROM jobs
  WHERE jobs.deleted_at IS NULL
    AND jobs.source_deleted_at IS NULL
    AND jobs.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SOURCE_MUTATED')
    AND COALESCE(jobs.uploaded_at, jobs.created_at) <= ?1
    AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
  ORDER BY COALESCE(jobs.uploaded_at, jobs.created_at), jobs.id
  LIMIT ?2
`;

const MARK_SOURCE_DELETED_SQL = `
  UPDATE jobs
  SET
    source_deleted_at = ?4,
    updated_at = ?4,
    version = version + 1
  WHERE id = ?1
    AND version = ?2
    AND source_key = ?3
    AND deleted_at IS NULL
    AND source_deleted_at IS NULL
    AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SOURCE_MUTATED')
    AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
  RETURNING id
`;

const FIND_RESULT_RETENTION_CANDIDATES_SQL = `
  SELECT
    attempts.id,
    attempts.job_id,
    attempts.result_prefix,
    attempts.status,
    attempts.updated_at
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.deleted_at IS NULL
    AND attempts.results_deleted_at IS NULL
    AND attempts.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
    AND COALESCE(attempts.completed_at, attempts.failed_at, attempts.updated_at) <= ?1
    AND ${ATTEMPT_PROVIDER_COMPATIBILITY_PREDICATE}
  ORDER BY
    COALESCE(attempts.completed_at, attempts.failed_at, attempts.updated_at),
    attempts.id
  LIMIT ?2
`;

const MARK_RESULTS_DELETED_SQL = `
  UPDATE job_attempts
  SET
    results_deleted_at = ?5,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND result_prefix = ?3
    AND status = ?4
    AND updated_at = ?6
    AND results_deleted_at IS NULL
    AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')
    AND ${UPDATE_ATTEMPT_PROVIDER_COMPATIBILITY_PREDICATE}
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const DELETE_RETAINED_ARTIFACT_ROWS_SQL = `
  DELETE FROM job_artifacts
  WHERE attempt_id = ?1
    AND job_id = ?2
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?1
        AND job_id = ?2
        AND results_deleted_at = ?3
    )
`;

const FIND_AUDIT_RETENTION_CANDIDATES_SQL = `
  SELECT
    jobs.id,
    jobs.version,
    MAX(attempts.heartbeat_issued_at) AS latest_capability_issued_at
  FROM jobs
  LEFT JOIN job_attempts AS attempts ON attempts.job_id = jobs.id
  WHERE jobs.deleted_at IS NULL
    AND jobs.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SOURCE_MUTATED')
    AND jobs.created_at <= ?1
    AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
  GROUP BY jobs.id, jobs.version
  ORDER BY jobs.created_at, jobs.id
  LIMIT ?2
`;

const MARK_AUDIT_RETENTION_EXPIRED_SQL = `
  UPDATE jobs
  SET
    deleted_at = ?4,
    deletion_not_before = ?5,
    deletion_next_attempt_at = ?4,
    deletion_attempt_count = 0,
    deletion_error_code = NULL,
    updated_at = ?4,
    version = version + 1
  WHERE id = ?1
    AND version = ?2
    AND deleted_at IS NULL
    AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SOURCE_MUTATED')
    AND created_at <= ?3
    AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
  RETURNING id
`;

const RECORD_AUDIT_RETENTION_EVENT_SQL = `
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
    'job_retention_expired',
    'orchestrator',
    NULL,
    ?3
  FROM jobs
  WHERE jobs.id = ?2
    AND jobs.deleted_at = ?3
  ON CONFLICT DO NOTHING
  RETURNING id
`;

export interface SourceRetentionCandidate {
  readonly jobId: string;
  readonly sourceKey: string;
  readonly version: number;
}

export interface ResultRetentionCandidate {
  readonly attemptId: string;
  readonly attemptStatus: "CANCELLED" | "COMPLETED" | "FAILED";
  readonly expectedUpdatedAt: string;
  readonly jobId: string;
  readonly resultPrefix: string;
}

export interface AuditRetentionCandidate {
  readonly jobId: string;
  readonly latestCapabilityIssuedAt: string | null;
  readonly version: number;
}

export interface RetentionRepository {
  findAuditRetentionCandidates(
    cutoff: string,
    limit: number,
  ): Promise<readonly AuditRetentionCandidate[]>;
  findResultRetentionCandidates(
    cutoff: string,
    limit: number,
  ): Promise<readonly ResultRetentionCandidate[]>;
  findSourceRetentionCandidates(
    cutoff: string,
    limit: number,
  ): Promise<readonly SourceRetentionCandidate[]>;
  markAuditRetentionExpired(input: {
    readonly cutoff: string;
    readonly eventId: string;
    readonly expectedVersion: number;
    readonly jobId: string;
    readonly latestCapabilityIssuedAt: string | null;
    readonly timestamp: string;
  }): Promise<boolean>;
  markResultsDeleted(
    input: ResultRetentionCandidate & {
      readonly timestamp: string;
    },
  ): Promise<boolean>;
  markSourceDeleted(
    input: SourceRetentionCandidate & {
      readonly timestamp: string;
    },
  ): Promise<boolean>;
}

function parseLimit(limit: number): number {
  return z.number().int().min(1).max(RETENTION_LIMIT_MAX).parse(limit);
}

export function createD1RetentionRepository(database: D1Database): RetentionRepository {
  return {
    async findAuditRetentionCandidates(cutoff, limit) {
      const rows = auditCandidateRowSchema
        .array()
        .parse(
          (
            await database
              .prepare(FIND_AUDIT_RETENTION_CANDIDATES_SQL)
              .bind(utcDateTimeSchema.parse(cutoff), parseLimit(limit))
              .all()
          ).results,
        );
      return rows.map((row) => ({
        jobId: row.id,
        latestCapabilityIssuedAt: row.latest_capability_issued_at,
        version: row.version,
      }));
    },

    async findResultRetentionCandidates(cutoff, limit) {
      const rows = resultCandidateRowSchema
        .array()
        .parse(
          (
            await database
              .prepare(FIND_RESULT_RETENTION_CANDIDATES_SQL)
              .bind(utcDateTimeSchema.parse(cutoff), parseLimit(limit))
              .all()
          ).results,
        );
      return rows.map((row) => ({
        attemptId: row.id,
        attemptStatus: z.enum(["CANCELLED", "COMPLETED", "FAILED"]).parse(row.status),
        expectedUpdatedAt: row.updated_at,
        jobId: row.job_id,
        resultPrefix: row.result_prefix,
      }));
    },

    async findSourceRetentionCandidates(cutoff, limit) {
      const rows = sourceCandidateRowSchema
        .array()
        .parse(
          (
            await database
              .prepare(FIND_SOURCE_RETENTION_CANDIDATES_SQL)
              .bind(utcDateTimeSchema.parse(cutoff), parseLimit(limit))
              .all()
          ).results,
        );
      return rows.map((row) => ({
        jobId: row.id,
        sourceKey: row.source_key,
        version: row.version,
      }));
    },

    async markAuditRetentionExpired(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const latestCapabilityIssuedAt =
        input.latestCapabilityIssuedAt === null
          ? null
          : utcDateTimeSchema.parse(input.latestCapabilityIssuedAt);
      const deletionNotBefore = new Date(
        deletionNotBeforeMilliseconds(
          Date.parse(timestamp),
          latestCapabilityIssuedAt === null ? null : Date.parse(latestCapabilityIssuedAt),
        ),
      ).toISOString();
      const jobId = ulidSchema.parse(input.jobId);
      const results = await database.batch([
        database
          .prepare(MARK_AUDIT_RETENTION_EXPIRED_SQL)
          .bind(
            jobId,
            z.number().int().positive().parse(input.expectedVersion),
            utcDateTimeSchema.parse(input.cutoff),
            timestamp,
            deletionNotBefore,
          ),
        database
          .prepare(RECORD_AUDIT_RETENTION_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), jobId, timestamp),
      ]);
      const updatedJob = mutationRowSchema.array().parse(results[0]?.results ?? [])[0];
      const insertedEvent = mutationRowSchema.array().parse(results[1]?.results ?? [])[0];
      if (updatedJob !== undefined && insertedEvent !== undefined) {
        return true;
      }
      if (updatedJob !== undefined || insertedEvent !== undefined) {
        throw new Error("Audit retention transition was only partially persisted");
      }
      return false;
    },

    async markResultsDeleted(input) {
      const attemptId = ulidSchema.parse(input.attemptId);
      const jobId = ulidSchema.parse(input.jobId);
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(MARK_RESULTS_DELETED_SQL)
          .bind(
            attemptId,
            jobId,
            z
              .string()
              .min(1)
              .max(900)
              .startsWith("results/")
              .endsWith("/")
              .parse(input.resultPrefix),
            z.enum(["CANCELLED", "COMPLETED", "FAILED"]).parse(input.attemptStatus),
            timestamp,
            utcDateTimeSchema.parse(input.expectedUpdatedAt),
          ),
        database.prepare(DELETE_RETAINED_ARTIFACT_ROWS_SQL).bind(attemptId, jobId, timestamp),
      ]);
      return mutationRowSchema.array().parse(results[0]?.results ?? []).length === 1;
    },

    async markSourceDeleted(input) {
      const rows = await database
        .prepare(MARK_SOURCE_DELETED_SQL)
        .bind(
          ulidSchema.parse(input.jobId),
          z.number().int().positive().parse(input.version),
          z.string().min(1).max(1_024).startsWith("incoming/").parse(input.sourceKey),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      return mutationRowSchema.array().parse(rows.results).length === 1;
    },
  };
}
