import { runpodJobIdSchema, ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const DELETION_LIMIT_MAX = 100;
const PAGE_LIMIT_MAX = 100;

const deletionCandidateRowSchema = z
  .object({
    deletion_attempt_count: z.number().int().nonnegative(),
    deletion_not_before: utcDateTimeSchema,
    id: ulidSchema,
    source_key: z.string().min(1).max(1_024).startsWith("incoming/"),
    version: z.number().int().positive(),
  })
  .strict();

const resultPrefixRowSchema = z
  .object({
    generation: z.number().int().positive(),
    result_prefix: z.string().min(1).max(900).startsWith("results/").endsWith("/"),
  })
  .strict();

const runpodJobIdRowSchema = z
  .object({
    runpod_job_id: runpodJobIdSchema,
  })
  .strict();

const mutationRowSchema = z
  .object({
    id: ulidSchema,
  })
  .strict();

const existenceRowSchema = z
  .object({
    id: ulidSchema,
  })
  .strict();

const deletionErrorCodeSchema = z.enum([
  "RUNPOD_CANCEL_FAILED",
  "R2_DELETE_FAILED",
  "D1_DELETE_FAILED",
]);

const FIND_DELETION_CANDIDATES_SQL = `
  SELECT
    id,
    source_key,
    deletion_not_before,
    deletion_attempt_count,
    version
  FROM jobs
  WHERE deleted_at IS NOT NULL
    AND deletion_not_before IS NOT NULL
    AND deletion_next_attempt_at IS NOT NULL
    AND deletion_next_attempt_at <= ?1
  ORDER BY deletion_next_attempt_at, id
  LIMIT ?2
`;

const FIND_RESULT_PREFIXES_SQL = `
  SELECT generation, result_prefix
  FROM job_attempts
  WHERE job_id = ?1
    AND generation > ?2
  ORDER BY generation
  LIMIT ?3
`;

const FIND_RUNPOD_JOB_IDS_SQL = `
  WITH known_runpod_jobs(runpod_job_id) AS (
    SELECT submissions.runpod_job_id
    FROM runpod_submissions AS submissions
    INNER JOIN job_attempts AS attempts ON attempts.id = submissions.attempt_id
    WHERE attempts.job_id = ?1

    UNION

    SELECT winning_runpod_job_id
    FROM job_attempts
    WHERE job_id = ?1
      AND winning_runpod_job_id IS NOT NULL

    UNION

    SELECT runpod_terminal_job_id
    FROM job_attempts
    WHERE job_id = ?1
      AND runpod_terminal_job_id IS NOT NULL
  )
  SELECT runpod_job_id
  FROM known_runpod_jobs
  WHERE ?2 IS NULL OR runpod_job_id > ?2
  ORDER BY runpod_job_id
  LIMIT ?3
`;

const FIND_PROVIDER_EXECUTION_DRIFT_SQL = `
  SELECT attempts.id
  FROM job_attempts AS attempts
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE attempts.job_id = ?1
    AND (
      (attempts.provider_kind IS NULL AND executions.id IS NOT NULL)
      OR (
        attempts.provider_kind IS NOT NULL
        AND (
          executions.id IS NULL
          OR executions.id <> attempts.id
          OR executions.provider_kind <> attempts.provider_kind
          OR executions.provider_policy <> attempts.provider_policy
          OR executions.status <> CASE attempts.status
            WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
            WHEN 'SUBMITTING' THEN 'CREATING'
            WHEN 'RUNNING' THEN 'RUNNING'
            WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
            ELSE 'TERMINAL'
          END
          OR executions.create_outcome IS NOT attempts.submission_outcome
          OR executions.provider_handle IS NOT attempts.winning_runpod_job_id
          OR executions.terminal_status IS NOT attempts.runpod_terminal_status
        )
      )
    )
  LIMIT 1
`;

const DEFER_DELETION_SQL = `
  UPDATE jobs
  SET
    deletion_next_attempt_at = ?4,
    deletion_error_code = NULL,
    updated_at = ?2,
    version = version + 1
  WHERE id = ?1
    AND version = ?3
    AND deleted_at IS NOT NULL
  RETURNING id
`;

const RECORD_DELETION_RETRY_SQL = `
  UPDATE jobs
  SET
    deletion_attempt_count = deletion_attempt_count + 1,
    deletion_error_code = ?4,
    deletion_next_attempt_at = ?5,
    updated_at = ?2,
    version = version + 1
  WHERE id = ?1
    AND version = ?3
    AND deleted_at IS NOT NULL
  RETURNING id
`;

const DELETE_JOB_RECORD_SQL = `
  DELETE FROM jobs
  WHERE id = ?1
    AND version = ?2
    AND deleted_at IS NOT NULL
    AND deletion_not_before IS NOT NULL
    AND deletion_not_before <= ?3
  RETURNING id
`;

const FIND_JOB_SQL = `
  SELECT id
  FROM jobs
  WHERE id = ?1
`;

export interface DeletionCandidate {
  readonly deletionAttemptCount: number;
  readonly deletionNotBefore: string;
  readonly jobId: string;
  readonly sourceKey: string;
  readonly version: number;
}

export interface ResultPrefixPage {
  readonly nextGeneration: number | null;
  readonly prefixes: readonly string[];
}

export interface RunpodJobIdPage {
  readonly jobIds: readonly string[];
  readonly nextCursor: string | null;
}

export type DeleteJobRecordResult = "conflict" | "deleted" | "not_found";

export interface DeletionRepository {
  assertProviderCompatibility(jobId: string): Promise<void>;
  deferDeletion(input: {
    readonly expectedVersion: number;
    readonly jobId: string;
    readonly nextAttemptAt: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  deleteJobRecord(input: {
    readonly expectedVersion: number;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<DeleteJobRecordResult>;
  findDeletionCandidates(timestamp: string, limit: number): Promise<readonly DeletionCandidate[]>;
  findResultPrefixes(
    jobId: string,
    afterGeneration: number,
    limit: number,
  ): Promise<ResultPrefixPage>;
  findRunpodJobIds(
    jobId: string,
    afterRunpodJobId: string | null,
    limit: number,
  ): Promise<RunpodJobIdPage>;
  recordDeletionRetry(input: {
    readonly errorCode: z.infer<typeof deletionErrorCodeSchema>;
    readonly expectedVersion: number;
    readonly jobId: string;
    readonly nextAttemptAt: string;
    readonly timestamp: string;
  }): Promise<boolean>;
}

function parseLimit(limit: number, maximum: number): number {
  return z.number().int().min(1).max(maximum).parse(limit);
}

export function createD1DeletionRepository(database: D1Database): DeletionRepository {
  return {
    async assertProviderCompatibility(jobId) {
      const row = await database
        .prepare(FIND_PROVIDER_EXECUTION_DRIFT_SQL)
        .bind(ulidSchema.parse(jobId))
        .first();
      if (row !== null) {
        throw new Error("Provider execution compatibility check failed");
      }
    },
    async deferDeletion(input) {
      const rows = await database
        .prepare(DEFER_DELETION_SQL)
        .bind(
          ulidSchema.parse(input.jobId),
          utcDateTimeSchema.parse(input.timestamp),
          z.number().int().positive().parse(input.expectedVersion),
          utcDateTimeSchema.parse(input.nextAttemptAt),
        )
        .all();
      return mutationRowSchema.array().parse(rows.results).length === 1;
    },

    async deleteJobRecord(input) {
      const jobId = ulidSchema.parse(input.jobId);
      const rows = await database
        .prepare(DELETE_JOB_RECORD_SQL)
        .bind(
          jobId,
          z.number().int().positive().parse(input.expectedVersion),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      if (mutationRowSchema.array().parse(rows.results).length === 1) {
        return "deleted";
      }
      const existing = await database.prepare(FIND_JOB_SQL).bind(jobId).first();
      if (existing === null) {
        return "not_found";
      }
      existenceRowSchema.parse(existing);
      return "conflict";
    },

    async findDeletionCandidates(timestamp, limit) {
      const rows = await database
        .prepare(FIND_DELETION_CANDIDATES_SQL)
        .bind(utcDateTimeSchema.parse(timestamp), parseLimit(limit, DELETION_LIMIT_MAX))
        .all();
      return deletionCandidateRowSchema
        .array()
        .parse(rows.results)
        .map((row) => ({
          deletionAttemptCount: row.deletion_attempt_count,
          deletionNotBefore: row.deletion_not_before,
          jobId: row.id,
          sourceKey: row.source_key,
          version: row.version,
        }));
    },

    async findResultPrefixes(jobId, afterGeneration, limit) {
      const rows = resultPrefixRowSchema
        .array()
        .parse(
          (
            await database
              .prepare(FIND_RESULT_PREFIXES_SQL)
              .bind(
                ulidSchema.parse(jobId),
                z.number().int().nonnegative().parse(afterGeneration),
                parseLimit(limit, PAGE_LIMIT_MAX),
              )
              .all()
          ).results,
        );
      return {
        nextGeneration:
          rows.length === parseLimit(limit, PAGE_LIMIT_MAX)
            ? (rows.at(-1)?.generation ?? null)
            : null,
        prefixes: rows.map((row) => row.result_prefix),
      };
    },

    async findRunpodJobIds(jobId, afterRunpodJobId, limit) {
      const parsedLimit = parseLimit(limit, PAGE_LIMIT_MAX);
      const parsedCursor =
        afterRunpodJobId === null ? null : runpodJobIdSchema.parse(afterRunpodJobId);
      const rows = runpodJobIdRowSchema
        .array()
        .parse(
          (
            await database
              .prepare(FIND_RUNPOD_JOB_IDS_SQL)
              .bind(ulidSchema.parse(jobId), parsedCursor, parsedLimit)
              .all()
          ).results,
        );
      return {
        jobIds: rows.map((row) => row.runpod_job_id),
        nextCursor: rows.length === parsedLimit ? (rows.at(-1)?.runpod_job_id ?? null) : null,
      };
    },

    async recordDeletionRetry(input) {
      const rows = await database
        .prepare(RECORD_DELETION_RETRY_SQL)
        .bind(
          ulidSchema.parse(input.jobId),
          utcDateTimeSchema.parse(input.timestamp),
          z.number().int().positive().parse(input.expectedVersion),
          deletionErrorCodeSchema.parse(input.errorCode),
          utcDateTimeSchema.parse(input.nextAttemptAt),
        )
        .all();
      return mutationRowSchema.array().parse(rows.results).length === 1;
    },
  };
}
