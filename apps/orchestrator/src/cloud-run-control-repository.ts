import {
  cloudRunOpaqueHandleSchema,
  ulidSchema,
  utcDateTimeSchema,
  type CloudRunControllerResponse,
} from "@scribe-drop/contracts";
import { z } from "zod";

const candidateRowSchema = z
  .object({
    attempt_id: ulidSchema,
    job_id: ulidSchema,
    submission_started_at: utcDateTimeSchema.nullable(),
  })
  .strict();
const mutationRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);
const dispatchableJobRowSchema = z.object({ id: ulidSchema }).strict();
const reconciliationCandidateRowSchema = z
  .object({
    attempt_id: ulidSchema,
    cleanup_status: z.enum(["NOT_REQUESTED", "PENDING", "IN_PROGRESS", "FAILED"]),
    execution_status: z.enum(["CREATING", "RUNNING", "CANCEL_REQUESTED", "TERMINAL"]),
    execution_updated_at: utcDateTimeSchema,
    execution_version: z.number().int().positive(),
    job_deleted: z.union([z.literal(0), z.literal(1)]),
    job_id: ulidSchema,
    job_status: z.enum([
      "SUBMITTING",
      "RUNNING",
      "CANCEL_REQUESTED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
    provider_handle: cloudRunOpaqueHandleSchema,
    provider_version: z.number().int().nonnegative(),
    terminal_status: z.enum(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]).nullable(),
  })
  .strict();

const FIND_CANDIDATE_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.submission_started_at
  FROM jobs
  INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
  INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.id = ?1
    AND jobs.deleted_at IS NULL
    AND jobs.status IN ('SUBMISSION_PENDING', 'SUBMITTING')
    AND attempts.status IN ('SUBMISSION_PENDING', 'SUBMITTING')
    AND attempts.provider_kind = 'cloud_run_jobs'
    AND attempts.provider_policy = 'cloud_run_jobs_l4_v1'
    AND attempts.execution_contract_version = 2
    AND executions.id = attempts.id
    AND executions.provider_kind = attempts.provider_kind
    AND executions.provider_policy = attempts.provider_policy
    AND executions.status IN ('PENDING', 'CREATING')
    AND executions.provider_handle IS NULL
  LIMIT 1
`;

const CLAIM_EXECUTION_SQL = `
  UPDATE provider_executions
  SET
    status = 'CREATING',
    create_outcome = NULL,
    provider_handle = ?3,
    provider_version = NULL,
    version = version + 1,
    updated_at = ?4
  WHERE attempt_id = ?1
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND status = 'PENDING'
    AND provider_handle IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM job_attempts AS active_attempt
      WHERE active_attempt.id <> ?1
        AND active_attempt.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
      WHERE jobs.id = ?2
        AND jobs.status = 'SUBMISSION_PENDING'
        AND jobs.deleted_at IS NULL
        AND attempts.id = ?1
        AND attempts.job_id = jobs.id
        AND attempts.status = 'SUBMISSION_PENDING'
    )
  RETURNING id
`;

const CLAIM_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'SUBMITTING',
    submission_started_at = ?3,
    submission_finished_at = NULL,
    submission_outcome = NULL,
    updated_at = ?3
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMISSION_PENDING'
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND execution_contract_version = 2
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1
        AND status = 'CREATING'
        AND provider_handle IS NOT NULL
        AND updated_at = ?3
    )
  RETURNING id
`;

const CLAIM_JOB_SQL = `
  UPDATE jobs
  SET status = 'SUBMITTING', updated_at = ?3, version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'SUBMISSION_PENDING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = 'SUBMITTING'
        AND updated_at = ?3
    )
  RETURNING id
`;

const RECORD_RESPONSE_EXECUTION_SQL = `
  UPDATE provider_executions
  SET
    status = CASE WHEN ?4 = 'running' THEN 'RUNNING' ELSE 'CREATING' END,
    create_outcome = CASE
      WHEN ?4 IN ('unknown', 'rejected') THEN 'unknown'
      ELSE 'accepted'
    END,
    provider_version = ?5,
    version = version + 1,
    updated_at = ?6
  WHERE attempt_id = ?1
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND provider_handle = ?3
    AND status = 'CREATING'
  RETURNING id
`;

const RECORD_RESPONSE_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = CASE WHEN ?4 = 'running' THEN 'RUNNING' ELSE 'SUBMITTING' END,
    submission_outcome = CASE
      WHEN ?4 IN ('unknown', 'rejected') THEN 'unknown'
      ELSE 'accepted'
    END,
    submission_finished_at = ?5,
    claimed_at = CASE WHEN ?4 = 'running' THEN COALESCE(claimed_at, ?5) ELSE claimed_at END,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1
        AND provider_handle = ?3
        AND status = CASE WHEN ?4 = 'running' THEN 'RUNNING' ELSE 'CREATING' END
        AND provider_version IS ?6
        AND updated_at = ?5
    )
  RETURNING id
`;

const RECORD_RESPONSE_JOB_SQL = `
  UPDATE jobs
  SET
    status = CASE WHEN ?3 = 'running' THEN 'RUNNING' ELSE 'SUBMITTING' END,
    updated_at = ?4,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'SUBMITTING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = CASE WHEN ?3 = 'running' THEN 'RUNNING' ELSE 'SUBMITTING' END
        AND updated_at = ?4
    )
  RETURNING id
`;

const RECORD_UNKNOWN_EXECUTION_SQL = `
  UPDATE provider_executions
  SET create_outcome = 'unknown', version = version + 1, updated_at = ?3
  WHERE attempt_id = ?1
    AND provider_handle = ?2
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND status = 'CREATING'
  RETURNING id
`;

const RECORD_UNKNOWN_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET submission_outcome = 'unknown', submission_finished_at = ?3, updated_at = ?3
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1 AND create_outcome = 'unknown' AND updated_at = ?3
    )
  RETURNING id
`;

const RECORD_REJECTED_EXECUTION_SQL = `
  UPDATE provider_executions
  SET
    status = 'TERMINAL',
    create_outcome = 'rejected',
    terminal_status = 'FAILED',
    cleanup_status = 'SUCCEEDED',
    provider_version = ?4,
    version = version + 1,
    updated_at = ?5
  WHERE attempt_id = ?1
    AND provider_handle = ?3
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND status = 'CREATING'
  RETURNING id
`;

const RECORD_REJECTED_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    submission_outcome = 'rejected',
    submission_finished_at = ?4,
    failed_at = ?4,
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    updated_at = ?4
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1 AND provider_handle = ?3
        AND status = 'TERMINAL' AND create_outcome = 'rejected' AND updated_at = ?4
    )
  RETURNING id
`;

const RECORD_REJECTED_EVENT_SQL = `
  INSERT INTO job_events (
    id, job_id, attempt_id, event_type, actor, metadata_json, created_at
  )
  SELECT ?1, ?2, ?3, 'cloud_run_submission_rejected', 'orchestrator', NULL, ?4
  WHERE EXISTS (
    SELECT 1 FROM job_attempts
    WHERE id = ?3 AND job_id = ?2 AND status = 'FAILED' AND updated_at = ?4
  )
  ON CONFLICT(id) DO NOTHING
  RETURNING id
`;

const FIND_RECONCILIATION_CANDIDATES_SQL = `
  SELECT
    attempts.id AS attempt_id,
    executions.cleanup_status,
    executions.status AS execution_status,
    executions.updated_at AS execution_updated_at,
    executions.version AS execution_version,
    CASE WHEN jobs.deleted_at IS NULL THEN 0 ELSE 1 END AS job_deleted,
    jobs.id AS job_id,
    jobs.status AS job_status,
    executions.provider_handle,
    COALESCE(executions.provider_version, 0) AS provider_version,
    executions.terminal_status
  FROM provider_executions AS executions
  INNER JOIN job_attempts AS attempts ON attempts.id = executions.attempt_id
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE executions.provider_kind = 'cloud_run_jobs'
    AND executions.provider_policy = 'cloud_run_jobs_l4_v1'
    AND executions.provider_handle IS NOT NULL
    AND (
      executions.status IN ('CREATING', 'RUNNING', 'CANCEL_REQUESTED')
      OR executions.cleanup_status IN ('PENDING', 'IN_PROGRESS', 'FAILED')
      OR (
        executions.status = 'TERMINAL'
        AND executions.cleanup_status = 'NOT_REQUESTED'
      )
    )
  ORDER BY executions.updated_at, executions.id
  LIMIT ?1
`;

const FIND_CANCELLATION_CANDIDATE_SQL = `
  SELECT
    attempts.id AS attempt_id,
    executions.cleanup_status,
    executions.status AS execution_status,
    executions.updated_at AS execution_updated_at,
    executions.version AS execution_version,
    0 AS job_deleted,
    jobs.id AS job_id,
    jobs.status AS job_status,
    executions.provider_handle,
    COALESCE(executions.provider_version, 0) AS provider_version,
    executions.terminal_status
  FROM jobs
  INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
  INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.id = ?1
    AND jobs.deleted_at IS NULL
    AND jobs.status = 'CANCEL_REQUESTED'
    AND attempts.job_id = jobs.id
    AND attempts.status = 'CANCEL_REQUESTED'
    AND attempts.provider_kind = 'cloud_run_jobs'
    AND attempts.provider_policy = 'cloud_run_jobs_l4_v1'
    AND executions.provider_kind = attempts.provider_kind
    AND executions.provider_policy = attempts.provider_policy
    AND executions.provider_handle IS NOT NULL
    AND executions.status IN ('CREATING', 'RUNNING', 'CANCEL_REQUESTED')
  LIMIT 1
`;

const FIND_DISPATCHABLE_PENDING_JOB_SQL = `
  SELECT jobs.id
  FROM jobs
  INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
  INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.status = 'SUBMISSION_PENDING'
    AND jobs.deleted_at IS NULL
    AND attempts.status = 'SUBMISSION_PENDING'
    AND attempts.provider_kind = 'cloud_run_jobs'
    AND attempts.provider_policy = 'cloud_run_jobs_l4_v1'
    AND attempts.execution_contract_version = 2
    AND executions.status = 'PENDING'
    AND executions.provider_handle IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM job_attempts AS active_attempt
      WHERE active_attempt.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    )
  ORDER BY jobs.updated_at, jobs.id
  LIMIT 1
`;

const APPLY_PROVIDER_RESPONSE_SQL = `
  UPDATE provider_executions
  SET
    status = CASE
      WHEN ?6 IN ('failed', 'cancelled', 'succeeded', 'cleaned') THEN 'TERMINAL'
      WHEN ?6 = 'running' THEN 'RUNNING'
      WHEN ?5 = 'cancel' AND ?6 IN ('accepted', 'pending') THEN 'CANCEL_REQUESTED'
      ELSE status
    END,
    create_outcome = CASE
      WHEN ?6 IN ('accepted', 'pending', 'running', 'succeeded', 'failed', 'cancelled', 'cleaned')
        THEN COALESCE(create_outcome, 'accepted')
      WHEN ?6 = 'unknown' THEN COALESCE(create_outcome, 'unknown')
      ELSE create_outcome
    END,
    terminal_status = CASE ?6
      WHEN 'succeeded' THEN 'COMPLETED'
      WHEN 'failed' THEN 'FAILED'
      WHEN 'cancelled' THEN 'CANCELLED'
      WHEN 'cleaned' THEN COALESCE(terminal_status, 'CANCELLED')
      ELSE terminal_status
    END,
    cleanup_status = CASE
      WHEN ?6 = 'cleaned' THEN 'SUCCEEDED'
      WHEN ?6 IN ('failed', 'cancelled') THEN 'PENDING'
      WHEN ?5 = 'cleanup' AND cleanup_status IN ('NOT_REQUESTED', 'PENDING')
        THEN 'IN_PROGRESS'
      ELSE cleanup_status
    END,
    provider_version = ?7,
    version = version + 1,
    updated_at = ?8
  WHERE attempt_id = ?1
    AND provider_handle = ?3
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND version = ?4
  RETURNING id
`;

const APPLY_ACTIVE_ATTEMPT_RESPONSE_SQL = `
  UPDATE job_attempts
  SET
    status = CASE
      WHEN ?4 = 'running' THEN 'RUNNING'
      WHEN ?4 = 'failed' THEN 'FAILED'
      WHEN ?4 = 'cancelled' THEN 'CANCELLED'
      WHEN ?4 = 'cleaned' THEN 'CANCELLED'
      ELSE status
    END,
    submission_outcome = CASE
      WHEN ?4 IN ('accepted', 'pending', 'running') THEN 'accepted'
      WHEN ?4 = 'unknown' THEN COALESCE(submission_outcome, 'unknown')
      ELSE submission_outcome
    END,
    submission_finished_at = CASE
      WHEN ?4 IN ('accepted', 'pending', 'running', 'unknown') THEN COALESCE(submission_finished_at, ?5)
      ELSE submission_finished_at
    END,
    claimed_at = CASE WHEN ?4 = 'running' THEN COALESCE(claimed_at, ?5) ELSE claimed_at END,
    failed_at = CASE WHEN ?4 = 'failed' THEN ?5 ELSE failed_at END,
    error_code = CASE WHEN ?4 = 'failed' THEN 'PROCESSING_FAILED' ELSE error_code END,
    error_message = CASE WHEN ?4 = 'failed' THEN NULL ELSE error_message END,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ?4 IN ('running', 'failed', 'cancelled', 'cleaned')
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1 AND provider_handle = ?3 AND updated_at = ?5
    )
  RETURNING id
`;

const APPLY_ACTIVE_JOB_RESPONSE_SQL = `
  UPDATE jobs
  SET
    status = CASE
      WHEN ?3 = 'running' THEN 'RUNNING'
      WHEN ?3 = 'failed' THEN 'FAILED'
      WHEN ?3 = 'cancelled' THEN 'CANCELLED'
      WHEN ?3 = 'cleaned' THEN 'CANCELLED'
      ELSE status
    END,
    failed_at = CASE WHEN ?3 = 'failed' THEN ?4 ELSE failed_at END,
    cancelled_at = CASE WHEN ?3 IN ('cancelled', 'cleaned') THEN ?4 ELSE cancelled_at END,
    error_code = CASE WHEN ?3 = 'failed' THEN 'PROCESSING_FAILED' ELSE error_code END,
    error_message = CASE WHEN ?3 = 'failed' THEN NULL ELSE error_message END,
    updated_at = ?4,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ?3 IN ('running', 'failed', 'cancelled', 'cleaned')
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM job_attempts
      WHERE id = ?2 AND job_id = ?1 AND updated_at = ?4
    )
  RETURNING id
`;

const FAIL_MISSING_TERMINAL_EXECUTION_SQL = `
  UPDATE provider_executions
  SET cleanup_status = 'PENDING', version = version + 1, updated_at = ?4
  WHERE attempt_id = ?1
    AND provider_handle = ?3
    AND provider_kind = 'cloud_run_jobs'
    AND status = 'TERMINAL'
    AND terminal_status IS NOT NULL
    AND cleanup_status = 'NOT_REQUESTED'
    AND version = ?5
  RETURNING id
`;

const FAIL_MISSING_TERMINAL_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET status = 'FAILED', error_code = 'PROCESSING_FAILED', error_message = NULL,
      failed_at = ?4, updated_at = ?4
  WHERE id = ?1
    AND job_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1 AND provider_handle = ?3 AND cleanup_status = 'PENDING'
        AND updated_at = ?4
    )
  RETURNING id
`;

export interface CloudRunSubmissionCandidate {
  readonly attemptId: string;
  readonly jobId: string;
  readonly submissionStartedAt: string | null;
}

export interface CloudRunReconciliationCandidate {
  readonly attemptId: string;
  readonly cleanupStatus: "FAILED" | "IN_PROGRESS" | "NOT_REQUESTED" | "PENDING";
  readonly executionStatus: "CANCEL_REQUESTED" | "CREATING" | "RUNNING" | "TERMINAL";
  readonly executionUpdatedAt: string;
  readonly executionVersion: number;
  readonly jobDeleted: boolean;
  readonly jobId: string;
  readonly jobStatus:
    "CANCELLED" | "CANCEL_REQUESTED" | "COMPLETED" | "FAILED" | "RUNNING" | "SUBMITTING";
  readonly providerHandle: string;
  readonly providerVersion: number;
  readonly terminalStatus: "CANCELLED" | "COMPLETED" | "FAILED" | "TIMED_OUT" | null;
}

export interface PreparedCloudRunSubmission extends CloudRunSubmissionCandidate {
  readonly executionHandle: string;
  readonly submissionStartedAt: string;
}

export interface CloudRunControlRepository {
  applyControllerResponse(input: {
    readonly action: "cancel" | "cleanup" | "observe" | "reconcile";
    readonly candidate: CloudRunReconciliationCandidate;
    readonly response: CloudRunControllerResponse;
    readonly timestamp: string;
  }): Promise<boolean>;
  failMissingTerminal(input: {
    readonly candidate: CloudRunReconciliationCandidate;
    readonly timestamp: string;
  }): Promise<boolean>;
  findCancellationCandidate(jobId: string): Promise<CloudRunReconciliationCandidate | undefined>;
  findDispatchablePendingJobId(): Promise<string | undefined>;
  findReconciliationCandidates(limit: number): Promise<readonly CloudRunReconciliationCandidate[]>;
  findSubmissionCandidate(jobId: string): Promise<CloudRunSubmissionCandidate | undefined>;
  prepareSubmission(input: {
    readonly candidate: CloudRunSubmissionCandidate;
    readonly executionHandle: string;
    readonly timestamp: string;
  }): Promise<PreparedCloudRunSubmission | undefined>;
  recordCreateResponse(input: {
    readonly attemptId: string;
    readonly executionHandle: string;
    readonly jobId: string;
    readonly response: CloudRunControllerResponse;
    readonly timestamp: string;
  }): Promise<boolean>;
  recordCreateRejected(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly executionHandle: string;
    readonly jobId: string;
    readonly response: CloudRunControllerResponse;
    readonly timestamp: string;
  }): Promise<boolean>;
  recordCreateUnknown(input: {
    readonly attemptId: string;
    readonly executionHandle: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
}

function mapReconciliationCandidate(
  row: z.infer<typeof reconciliationCandidateRowSchema>,
): CloudRunReconciliationCandidate {
  return {
    attemptId: row.attempt_id,
    cleanupStatus: row.cleanup_status,
    executionStatus: row.execution_status,
    executionUpdatedAt: row.execution_updated_at,
    executionVersion: row.execution_version,
    jobDeleted: row.job_deleted === 1,
    jobId: row.job_id,
    jobStatus: row.job_status,
    providerHandle: row.provider_handle,
    providerVersion: row.provider_version,
    terminalStatus: row.terminal_status,
  };
}

function mutationSucceeded(results: readonly D1Result[]): boolean {
  return results.every((result) => mutationRowsSchema.parse(result.results)[0] !== undefined);
}

export function createD1CloudRunControlRepository(database: D1Database): CloudRunControlRepository {
  return {
    async applyControllerResponse(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const candidate = input.candidate;
      const results = await database.batch([
        database
          .prepare(APPLY_PROVIDER_RESPONSE_SQL)
          .bind(
            candidate.attemptId,
            candidate.jobId,
            candidate.providerHandle,
            candidate.executionVersion,
            input.action,
            input.response.outcome,
            input.response.version,
            timestamp,
          ),
        database
          .prepare(APPLY_ACTIVE_ATTEMPT_RESPONSE_SQL)
          .bind(
            candidate.attemptId,
            candidate.jobId,
            candidate.providerHandle,
            input.response.outcome,
            timestamp,
          ),
        database
          .prepare(APPLY_ACTIVE_JOB_RESPONSE_SQL)
          .bind(candidate.jobId, candidate.attemptId, input.response.outcome, timestamp),
      ]);
      return mutationRowsSchema.parse(results[0]?.results ?? [])[0] !== undefined;
    },

    async failMissingTerminal(input) {
      const candidate = input.candidate;
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(FAIL_MISSING_TERMINAL_EXECUTION_SQL)
          .bind(
            candidate.attemptId,
            candidate.jobId,
            candidate.providerHandle,
            timestamp,
            candidate.executionVersion,
          ),
        database
          .prepare(FAIL_MISSING_TERMINAL_ATTEMPT_SQL)
          .bind(candidate.attemptId, candidate.jobId, candidate.providerHandle, timestamp),
        database
          .prepare(APPLY_ACTIVE_JOB_RESPONSE_SQL)
          .bind(candidate.jobId, candidate.attemptId, "failed", timestamp),
      ]);
      return mutationSucceeded(results);
    },

    async findCancellationCandidate(jobId) {
      const row = await database
        .withSession("first-primary")
        .prepare(FIND_CANCELLATION_CANDIDATE_SQL)
        .bind(ulidSchema.parse(jobId))
        .first();
      return row === null
        ? undefined
        : mapReconciliationCandidate(reconciliationCandidateRowSchema.parse(row));
    },

    async findReconciliationCandidates(limit) {
      const rows = await database
        .withSession("first-primary")
        .prepare(FIND_RECONCILIATION_CANDIDATES_SQL)
        .bind(z.number().int().min(1).max(100).parse(limit))
        .all();
      return reconciliationCandidateRowSchema
        .array()
        .parse(rows.results)
        .map(mapReconciliationCandidate);
    },

    async findDispatchablePendingJobId() {
      const row = await database
        .withSession("first-primary")
        .prepare(FIND_DISPATCHABLE_PENDING_JOB_SQL)
        .first();
      return row === null ? undefined : dispatchableJobRowSchema.parse(row).id;
    },

    async findSubmissionCandidate(jobId) {
      const row = await database
        .withSession("first-primary")
        .prepare(FIND_CANDIDATE_SQL)
        .bind(ulidSchema.parse(jobId))
        .first();
      if (row === null) return undefined;
      const parsed = candidateRowSchema.parse(row);
      return {
        attemptId: parsed.attempt_id,
        jobId: parsed.job_id,
        submissionStartedAt: parsed.submission_started_at,
      };
    },

    async prepareSubmission(input) {
      const attemptId = ulidSchema.parse(input.candidate.attemptId);
      const jobId = ulidSchema.parse(input.candidate.jobId);
      const executionHandle = cloudRunOpaqueHandleSchema.parse(input.executionHandle);
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      if (input.candidate.submissionStartedAt !== null) return undefined;
      const results = await database.batch([
        database.prepare(CLAIM_EXECUTION_SQL).bind(attemptId, jobId, executionHandle, timestamp),
        database.prepare(CLAIM_ATTEMPT_SQL).bind(attemptId, jobId, timestamp),
        database.prepare(CLAIM_JOB_SQL).bind(jobId, attemptId, timestamp),
      ]);
      return mutationSucceeded(results)
        ? { attemptId, executionHandle, jobId, submissionStartedAt: timestamp }
        : undefined;
    },

    async recordCreateResponse(input) {
      const response = input.response;
      if (
        !new Set(["accepted", "pending", "running", "unknown", "rejected"]).has(response.outcome)
      ) {
        return false;
      }
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(RECORD_RESPONSE_EXECUTION_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            ulidSchema.parse(input.jobId),
            cloudRunOpaqueHandleSchema.parse(input.executionHandle),
            response.outcome,
            response.version,
            timestamp,
          ),
        database
          .prepare(RECORD_RESPONSE_ATTEMPT_SQL)
          .bind(
            input.attemptId,
            input.jobId,
            input.executionHandle,
            response.outcome,
            timestamp,
            response.version,
          ),
        database
          .prepare(RECORD_RESPONSE_JOB_SQL)
          .bind(input.jobId, input.attemptId, response.outcome, timestamp),
      ]);
      return mutationSucceeded(results);
    },

    async recordCreateRejected(input) {
      const response = input.response;
      if (response.outcome !== "rejected" || response.errorCode === null) return false;
      const attemptId = ulidSchema.parse(input.attemptId);
      const jobId = ulidSchema.parse(input.jobId);
      const executionHandle = cloudRunOpaqueHandleSchema.parse(input.executionHandle);
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(RECORD_REJECTED_EXECUTION_SQL)
          .bind(attemptId, jobId, executionHandle, response.version, timestamp),
        database
          .prepare(RECORD_REJECTED_ATTEMPT_SQL)
          .bind(attemptId, jobId, executionHandle, timestamp),
        database.prepare(APPLY_ACTIVE_JOB_RESPONSE_SQL).bind(jobId, attemptId, "failed", timestamp),
        database
          .prepare(RECORD_REJECTED_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), jobId, attemptId, timestamp),
      ]);
      return mutationSucceeded(results);
    },

    async recordCreateUnknown(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(RECORD_UNKNOWN_EXECUTION_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            cloudRunOpaqueHandleSchema.parse(input.executionHandle),
            timestamp,
          ),
        database
          .prepare(RECORD_UNKNOWN_ATTEMPT_SQL)
          .bind(input.attemptId, ulidSchema.parse(input.jobId), timestamp),
      ]);
      return mutationSucceeded(results);
    },
  };
}
