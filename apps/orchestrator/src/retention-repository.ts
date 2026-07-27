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

const FIND_SOURCE_RETENTION_CANDIDATES_SQL = `
  SELECT id, source_key, version
  FROM jobs
  WHERE deleted_at IS NULL
    AND source_deleted_at IS NULL
    AND status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SOURCE_MUTATED')
    AND COALESCE(uploaded_at, created_at) <= ?1
  ORDER BY COALESCE(uploaded_at, created_at), id
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
  WHERE jobs.deleted_at IS NULL
    AND attempts.results_deleted_at IS NULL
    AND attempts.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
    AND COALESCE(attempts.completed_at, attempts.failed_at, attempts.updated_at) <= ?1
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
