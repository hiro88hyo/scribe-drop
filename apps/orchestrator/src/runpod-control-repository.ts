import {
  MAX_FILE_SIZE_BYTES,
  attemptStatusSchema,
  jobStatusSchema,
  runpodJobIdSchema,
  ulidSchema,
  utcDateTimeSchema,
  type AttemptStatus,
  type JobStatus,
} from "@scribe-drop/contracts";
import { z } from "zod";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const resultPrefixSchema = z.string().min(1).max(900).startsWith("results/").endsWith("/");
const updatedAttemptRowsSchema = z
  .array(
    z
      .object({
        generation: z.number().int().positive(),
        id: ulidSchema,
        job_id: ulidSchema,
      })
      .strict(),
  )
  .max(1);
const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);

const PREPARE_SUBMISSION_SQL = `
  UPDATE job_attempts
  SET
    status = 'SUBMITTING',
    claim_token_hash = ?2,
    claim_issued_at = ?3,
    claim_expires_at = ?4,
    claim_consumed_at = NULL,
    submission_started_at = ?3,
    submission_outcome = NULL,
    submission_finished_at = NULL,
    updated_at = ?3
  WHERE job_id = ?1
    AND id = (
      SELECT active_attempt_id
      FROM jobs
      WHERE id = ?1
        AND status = 'SUBMISSION_PENDING'
        AND deleted_at IS NULL
    )
    AND status = 'SUBMISSION_PENDING'
    AND claim_token_hash IS NULL
    AND claim_issued_at IS NULL
    AND claim_expires_at IS NULL
    AND claim_consumed_at IS NULL
    AND provider_kind = 'runpod_serverless'
    AND provider_policy = 'runpod_serverless_v1'
    AND execution_contract_version = 1
    AND execution_options_json IS NOT NULL
    AND json_extract(execution_options_json, '$.contractVersion') = 1
    AND json_extract(execution_options_json, '$.language') IN ('auto', 'ja')
    AND json_extract(execution_options_json, '$.model') = 'large-v3-turbo'
    AND json_type(execution_options_json, '$.vad') IN ('true', 'false')
    AND json_type(execution_options_json, '$.outputFormats') = 'array'
    AND json_array_length(execution_options_json, '$.outputFormats') BETWEEN 1 AND 3
    AND (SELECT COUNT(*) FROM json_each(execution_options_json)) = 5
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(execution_options_json, '$.outputFormats') AS formats
      WHERE formats.value NOT IN ('markdown', 'json', 'srt')
    )
    AND (
      SELECT COUNT(DISTINCT formats.value)
      FROM json_each(execution_options_json, '$.outputFormats') AS formats
    ) = json_array_length(execution_options_json, '$.outputFormats')
    AND EXISTS (
      SELECT 1
      FROM provider_executions AS executions
      WHERE executions.attempt_id = job_attempts.id
        AND executions.id = job_attempts.id
        AND executions.provider_kind = job_attempts.provider_kind
        AND executions.provider_policy = job_attempts.provider_policy
        AND executions.status = 'PENDING'
        AND executions.create_outcome IS submission_outcome
        AND executions.provider_handle IS winning_runpod_job_id
        AND executions.terminal_status IS runpod_terminal_status
    )
    AND NOT EXISTS (
      SELECT 1
      FROM job_attempts AS active_attempt
      WHERE active_attempt.id <> job_attempts.id
        AND active_attempt.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    )
  RETURNING id, job_id, generation
`;

const MARK_JOB_SUBMITTING_SQL = `
  UPDATE jobs
  SET
    status = 'SUBMITTING',
    processing_started_at = COALESCE(processing_started_at, ?2),
    updated_at = ?2,
    version = version + 1
  WHERE id = ?1
    AND status = 'SUBMISSION_PENDING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = jobs.active_attempt_id
        AND job_id = jobs.id
        AND status = 'SUBMITTING'
        AND claim_token_hash = ?3
        AND claim_issued_at = ?2
        AND EXISTS (
          SELECT 1
          FROM provider_executions AS executions
          WHERE executions.attempt_id = job_attempts.id
            AND executions.status = 'CREATING'
            AND executions.provider_kind = job_attempts.provider_kind
            AND executions.provider_policy = job_attempts.provider_policy
        )
    )
  RETURNING id
`;

const INSERT_SUBMISSION_SQL = `
  INSERT INTO runpod_submissions (
    runpod_job_id,
    attempt_id,
    is_winner,
    source,
    created_at,
    updated_at
  )
  SELECT
    ?1,
    ?2,
    0,
    ?3,
    ?4,
    ?4
  FROM job_attempts
  WHERE id = ?2
  ON CONFLICT(runpod_job_id) DO NOTHING
`;

const MARK_SUBMISSION_ACCEPTED_SQL = `
  UPDATE job_attempts
  SET
    submission_outcome = 'accepted',
    submission_finished_at = ?2,
    updated_at = ?2
  WHERE id = ?1
    AND status = 'SUBMITTING'
    AND EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = ?1
        AND runpod_job_id = ?3
        AND source = 'submit_response'
    )
  RETURNING id
`;

const MARK_SUBMISSION_UNKNOWN_SQL = `
  UPDATE job_attempts
  SET
    submission_outcome = 'unknown',
    submission_finished_at = ?2,
    updated_at = ?2
  WHERE id = ?1
    AND status = 'SUBMITTING'
    AND submission_outcome IS NULL
  RETURNING id
`;

const MARK_ATTEMPT_REJECTED_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    submission_outcome = 'rejected',
    submission_finished_at = ?2,
    failed_at = ?2,
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    updated_at = ?2
  WHERE id = ?1
    AND status = 'SUBMITTING'
    AND submission_outcome IS NULL
  RETURNING id
`;

const MARK_JOB_REJECTED_SQL = `
  UPDATE jobs
  SET
    status = 'FAILED',
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    failed_at = ?2,
    updated_at = ?2,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?3
    AND status = 'SUBMITTING'
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?3
        AND job_id = ?1
        AND status = 'FAILED'
        AND submission_outcome = 'rejected'
    )
  RETURNING id
`;

const FIND_CLAIM_CONTEXT_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.generation,
    attempts.status AS attempt_status,
    attempts.claim_token_hash,
    attempts.claim_issued_at,
    attempts.claim_expires_at,
    attempts.claim_consumed_at,
    attempts.heartbeat_token_hash,
    attempts.heartbeat_issued_at,
    attempts.heartbeat_expires_at,
    attempts.heartbeat_revoked_at,
    attempts.winning_runpod_job_id,
    attempts.result_prefix,
    jobs.status AS job_status,
    jobs.active_attempt_id,
    jobs.source_bucket,
    jobs.source_key,
    jobs.actual_size_bytes,
    jobs.source_etag
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE attempts.id = ?1
    AND attempts.job_id = ?2
    AND jobs.deleted_at IS NULL
    AND attempts.provider_kind = 'runpod_serverless'
    AND attempts.provider_policy = 'runpod_serverless_v1'
    AND attempts.execution_contract_version = 1
    AND attempts.execution_options_json IS NOT NULL
    AND executions.id = attempts.id
    AND executions.provider_kind = attempts.provider_kind
    AND executions.provider_policy = attempts.provider_policy
    AND executions.status = CASE attempts.status
      WHEN 'SUBMITTING' THEN 'CREATING'
      WHEN 'RUNNING' THEN 'RUNNING'
      WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
      ELSE 'TERMINAL'
    END
    AND executions.create_outcome IS attempts.submission_outcome
    AND executions.provider_handle IS attempts.winning_runpod_job_id
    AND executions.terminal_status IS attempts.runpod_terminal_status
  LIMIT 1
`;

const CLAIM_WINNER_SQL = `
  UPDATE job_attempts
  SET
    status = 'RUNNING',
    winning_runpod_job_id = ?3,
    claim_consumed_at = ?5,
    claimed_at = ?5,
    heartbeat_token_hash = ?6,
    heartbeat_issued_at = ?5,
    heartbeat_expires_at = ?7,
    heartbeat_revoked_at = NULL,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND winning_runpod_job_id IS NULL
    AND claim_token_hash = ?4
    AND claim_issued_at IS NOT NULL
    AND claim_expires_at > ?5
    AND claim_consumed_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = 'SUBMITTING'
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const MARK_SUBMISSION_WINNER_SQL = `
  UPDATE runpod_submissions
  SET
    is_winner = 1,
    updated_at = ?3
  WHERE runpod_job_id = ?1
    AND attempt_id = ?2
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND winning_runpod_job_id = ?1
    )
`;

const MARK_JOB_RUNNING_SQL = `
  UPDATE jobs
  SET
    status = 'RUNNING',
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'SUBMITTING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = 'RUNNING'
    )
  RETURNING id
`;

const RECORD_EVENT_SQL = `
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
    ?4,
    'orchestrator',
    NULL,
    ?5
  WHERE EXISTS (
    SELECT 1
    FROM job_attempts
    WHERE id = ?3
      AND job_id = ?2
      AND updated_at = ?5
  )
  ON CONFLICT(id) DO NOTHING
`;

const RECORD_CLAIM_EVENT_SQL = `
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
    'runpod_claim_granted',
    'orchestrator',
    NULL,
    ?5
  WHERE EXISTS (
    SELECT 1
    FROM job_attempts
    WHERE id = ?3
      AND job_id = ?2
      AND winning_runpod_job_id = ?4
      AND claimed_at = ?5
  )
  ON CONFLICT(id) DO NOTHING
`;

const HEARTBEAT_SQL = `
  UPDATE job_attempts
  SET
    heartbeat_at = ?5,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND winning_runpod_job_id = ?3
    AND heartbeat_token_hash = ?4
    AND heartbeat_issued_at IS NOT NULL
    AND heartbeat_expires_at > ?5
    AND heartbeat_revoked_at IS NULL
    AND status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status IN ('RUNNING', 'CANCEL_REQUESTED')
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const FIND_EXPIRED_UNKNOWN_SUBMISSIONS_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.claim_expires_at
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE attempts.status = 'SUBMITTING'
    AND (
      attempts.submission_outcome IS NULL
      OR attempts.submission_outcome = 'unknown'
    )
    AND attempts.claim_expires_at <= ?1
    AND attempts.winning_runpod_job_id IS NULL
    AND jobs.active_attempt_id = attempts.id
    AND jobs.status = 'SUBMITTING'
    AND jobs.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = attempts.id
    )
  ORDER BY attempts.claim_expires_at, attempts.id
  LIMIT ?2
`;

const FAIL_EXPIRED_UNKNOWN_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    failed_at = ?3,
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    updated_at = ?3
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND (
      submission_outcome IS NULL
      OR submission_outcome = 'unknown'
    )
    AND claim_expires_at <= ?3
    AND winning_runpod_job_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = ?1
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = 'SUBMITTING'
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const FAIL_EXPIRED_UNKNOWN_JOB_SQL = `
  UPDATE jobs
  SET
    status = 'FAILED',
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    failed_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'SUBMITTING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = 'FAILED'
        AND (
          submission_outcome IS NULL
          OR submission_outcome = 'unknown'
        )
        AND failed_at = ?3
        AND winning_runpod_job_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM runpod_submissions
          WHERE attempt_id = ?2
        )
    )
  RETURNING id
`;

const FIND_STALE_ACCEPTED_SUBMISSIONS_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.submission_finished_at,
    (
      SELECT submissions.runpod_job_id
      FROM runpod_submissions AS submissions
      WHERE submissions.attempt_id = attempts.id
        AND submissions.source = 'submit_response'
      ORDER BY submissions.created_at, submissions.runpod_job_id
      LIMIT 1
    ) AS runpod_job_id
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE attempts.status = 'SUBMITTING'
    AND attempts.submission_outcome = 'accepted'
    AND attempts.submission_finished_at <= ?1
    AND attempts.winning_runpod_job_id IS NULL
    AND attempts.runpod_terminal_status IS NULL
    AND jobs.active_attempt_id = attempts.id
    AND jobs.status = 'SUBMITTING'
    AND jobs.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM runpod_submissions AS submissions
      WHERE submissions.attempt_id = attempts.id
        AND submissions.source = 'submit_response'
    )
  ORDER BY attempts.submission_finished_at, attempts.id
  LIMIT ?2
`;

const FAIL_STALE_ACCEPTED_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    failed_at = ?3,
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    updated_at = ?3
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'SUBMITTING'
    AND submission_outcome = 'accepted'
    AND submission_finished_at <= ?5
    AND winning_runpod_job_id IS NULL
    AND runpod_terminal_status IS NULL
    AND EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = ?1
        AND runpod_job_id = ?4
        AND source = 'submit_response'
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = 'SUBMITTING'
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const FAIL_STALE_ACCEPTED_JOB_SQL = `
  UPDATE jobs
  SET
    status = 'FAILED',
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    failed_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'SUBMITTING'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = 'FAILED'
        AND submission_outcome = 'accepted'
        AND submission_finished_at <= ?5
        AND failed_at = ?3
        AND winning_runpod_job_id IS NULL
        AND runpod_terminal_status IS NULL
        AND EXISTS (
          SELECT 1
          FROM runpod_submissions
          WHERE attempt_id = ?2
            AND runpod_job_id = ?4
            AND source = 'submit_response'
        )
    )
  RETURNING id
`;

const FIND_FAILED_UNCLAIMED_SUBMISSIONS_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.submission_finished_at,
    (
      SELECT submissions.runpod_job_id
      FROM runpod_submissions AS submissions
      WHERE submissions.attempt_id = attempts.id
        AND submissions.source = 'submit_response'
      ORDER BY submissions.created_at, submissions.runpod_job_id
      LIMIT 1
    ) AS runpod_job_id
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE attempts.status = 'FAILED'
    AND attempts.error_code = 'PROCESSING_FAILED'
    AND attempts.submission_outcome = 'accepted'
    AND attempts.winning_runpod_job_id IS NULL
    AND attempts.runpod_terminal_status IS NULL
    AND jobs.active_attempt_id = attempts.id
    AND jobs.status = 'FAILED'
    AND jobs.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM runpod_submissions AS submissions
      WHERE submissions.attempt_id = attempts.id
        AND submissions.source = 'submit_response'
    )
  ORDER BY attempts.failed_at, attempts.id
  LIMIT ?1
`;

const MARK_FAILED_UNCLAIMED_SUBMISSION_CANCELLED_SQL = `
  UPDATE job_attempts
  SET
    runpod_terminal_job_id = ?3,
    runpod_terminal_status = 'CANCELLED',
    runpod_terminal_observed_at = ?4,
    updated_at = ?4
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'FAILED'
    AND error_code = 'PROCESSING_FAILED'
    AND submission_outcome = 'accepted'
    AND winning_runpod_job_id IS NULL
    AND runpod_terminal_status IS NULL
    AND EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = ?1
        AND runpod_job_id = ?3
        AND source = 'submit_response'
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = 'FAILED'
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const FIND_DISPATCHABLE_PENDING_JOB_SQL = `
  SELECT jobs.id
  FROM jobs
  INNER JOIN job_attempts ON job_attempts.id = jobs.active_attempt_id
  WHERE jobs.status = 'SUBMISSION_PENDING'
    AND jobs.deleted_at IS NULL
    AND job_attempts.job_id = jobs.id
    AND job_attempts.status = 'SUBMISSION_PENDING'
    AND NOT EXISTS (
      SELECT 1
      FROM job_attempts AS active_attempt
      WHERE active_attempt.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    )
  ORDER BY jobs.updated_at, jobs.id
  LIMIT 1
`;

const FIND_EXPIRED_UNBOUND_CANCELLATIONS_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.claim_expires_at
  FROM job_attempts AS attempts
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE attempts.status = 'CANCEL_REQUESTED'
    AND attempts.claim_expires_at <= ?1
    AND attempts.winning_runpod_job_id IS NULL
    AND jobs.active_attempt_id = attempts.id
    AND jobs.status = 'CANCEL_REQUESTED'
    AND jobs.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = attempts.id
    )
  ORDER BY attempts.claim_expires_at, attempts.id
  LIMIT ?2
`;

const CANCEL_EXPIRED_UNBOUND_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'CANCELLED',
    error_code = NULL,
    error_message = NULL,
    updated_at = ?3
  WHERE id = ?1
    AND job_id = ?2
    AND status = 'CANCEL_REQUESTED'
    AND claim_expires_at <= ?3
    AND winning_runpod_job_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM runpod_submissions
      WHERE attempt_id = ?1
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status = 'CANCEL_REQUESTED'
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const CANCEL_EXPIRED_UNBOUND_JOB_SQL = `
  UPDATE jobs
  SET
    status = 'CANCELLED',
    error_code = NULL,
    error_message = NULL,
    cancelled_at = ?3,
    updated_at = ?3,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status = 'CANCEL_REQUESTED'
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = 'CANCELLED'
        AND updated_at = ?3
        AND winning_runpod_job_id IS NULL
    )
  RETURNING id
`;

const claimContextRowSchema = z
  .object({
    active_attempt_id: ulidSchema,
    actual_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    attempt_id: ulidSchema,
    attempt_status: attemptStatusSchema,
    claim_consumed_at: utcDateTimeSchema.nullable(),
    claim_expires_at: utcDateTimeSchema,
    claim_issued_at: utcDateTimeSchema,
    claim_token_hash: sha256HexSchema,
    generation: z.number().int().positive(),
    heartbeat_expires_at: utcDateTimeSchema.nullable(),
    heartbeat_issued_at: utcDateTimeSchema.nullable(),
    heartbeat_revoked_at: utcDateTimeSchema.nullable(),
    heartbeat_token_hash: sha256HexSchema.nullable(),
    job_id: ulidSchema,
    job_status: jobStatusSchema,
    result_prefix: resultPrefixSchema,
    source_bucket: z.string().min(3).max(63),
    source_etag: z.string().min(1).max(512),
    source_key: z.string().min(1).max(1024).startsWith("incoming/"),
    winning_runpod_job_id: runpodJobIdSchema.nullable(),
  })
  .strict();

const expiredUnknownSubmissionRowSchema = z
  .object({
    attempt_id: ulidSchema,
    claim_expires_at: utcDateTimeSchema,
    job_id: ulidSchema,
  })
  .strict();
const staleAcceptedSubmissionRowSchema = z
  .object({
    attempt_id: ulidSchema,
    job_id: ulidSchema,
    runpod_job_id: runpodJobIdSchema,
    submission_finished_at: utcDateTimeSchema,
  })
  .strict();
const pendingJobRowSchema = z.object({ id: ulidSchema }).strict();
const reconciliationLimitSchema = z.number().int().min(1).max(100);

export interface PreparedSubmission {
  readonly attemptId: string;
  readonly generation: number;
  readonly jobId: string;
}

export interface ClaimContext {
  readonly activeAttemptId: string;
  readonly actualSizeBytes: number;
  readonly attemptId: string;
  readonly attemptStatus: AttemptStatus;
  readonly claimConsumedAt: string | null;
  readonly claimExpiresAt: string;
  readonly claimIssuedAt: string;
  readonly claimTokenHash: string;
  readonly generation: number;
  readonly heartbeatExpiresAt: string | null;
  readonly heartbeatIssuedAt: string | null;
  readonly heartbeatRevokedAt: string | null;
  readonly heartbeatTokenHash: string | null;
  readonly jobId: string;
  readonly jobStatus: JobStatus;
  readonly resultPrefix: string;
  readonly sourceBucket: string;
  readonly sourceEtag: string;
  readonly sourceKey: string;
  readonly winningRunpodJobId: string | null;
}

export interface ExpiredUnknownSubmission {
  readonly attemptId: string;
  readonly claimExpiresAt: string;
  readonly jobId: string;
}

export interface StaleAcceptedSubmission {
  readonly attemptId: string;
  readonly jobId: string;
  readonly runpodJobId: string;
  readonly submissionFinishedAt: string;
}

export interface RunpodControlRepository {
  cancelExpiredUnboundSubmission(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  claimWinner(input: {
    readonly attemptId: string;
    readonly claimTokenHash: string;
    readonly eventId: string;
    readonly heartbeatExpiresAt: string;
    readonly heartbeatTokenHash: string;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  findClaimContext(attemptId: string, jobId: string): Promise<ClaimContext | undefined>;
  findDispatchablePendingJobId(): Promise<string | undefined>;
  findExpiredUnknownSubmissions(
    timestamp: string,
    limit: number,
  ): Promise<readonly ExpiredUnknownSubmission[]>;
  findExpiredUnboundCancellations(
    timestamp: string,
    limit: number,
  ): Promise<readonly ExpiredUnknownSubmission[]>;
  findFailedUnclaimedSubmissions(limit: number): Promise<readonly StaleAcceptedSubmission[]>;
  findStaleAcceptedSubmissions(
    staleBefore: string,
    limit: number,
  ): Promise<readonly StaleAcceptedSubmission[]>;
  failStaleAcceptedSubmission(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly staleBefore: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  failExpiredUnknownSubmission(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  markFailedUnclaimedSubmissionCancelled(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  markHeartbeat(input: {
    readonly attemptId: string;
    readonly heartbeatTokenHash: string;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  prepareSubmission(input: {
    readonly claimExpiresAt: string;
    readonly claimTokenHash: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<PreparedSubmission | undefined>;
  recordClaimSubmission(input: {
    readonly attemptId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<void>;
  recordSubmissionAccepted(input: {
    readonly attemptId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  recordSubmissionRejected(input: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  recordSubmissionUnknown(attemptId: string, timestamp: string): Promise<boolean>;
}

function mapClaimContext(row: z.infer<typeof claimContextRowSchema>): ClaimContext {
  return {
    activeAttemptId: row.active_attempt_id,
    actualSizeBytes: row.actual_size_bytes,
    attemptId: row.attempt_id,
    attemptStatus: row.attempt_status,
    claimConsumedAt: row.claim_consumed_at,
    claimExpiresAt: row.claim_expires_at,
    claimIssuedAt: row.claim_issued_at,
    claimTokenHash: row.claim_token_hash,
    generation: row.generation,
    heartbeatExpiresAt: row.heartbeat_expires_at,
    heartbeatIssuedAt: row.heartbeat_issued_at,
    heartbeatRevokedAt: row.heartbeat_revoked_at,
    heartbeatTokenHash: row.heartbeat_token_hash,
    jobId: row.job_id,
    jobStatus: row.job_status,
    resultPrefix: row.result_prefix,
    sourceBucket: row.source_bucket,
    sourceEtag: row.source_etag,
    sourceKey: row.source_key,
    winningRunpodJobId: row.winning_runpod_job_id,
  };
}

function mapStaleAcceptedSubmission(
  row: z.infer<typeof staleAcceptedSubmissionRowSchema>,
): StaleAcceptedSubmission {
  return {
    attemptId: row.attempt_id,
    jobId: row.job_id,
    runpodJobId: row.runpod_job_id,
    submissionFinishedAt: row.submission_finished_at,
  };
}

export function createD1RunpodControlRepository(database: D1Database): RunpodControlRepository {
  return {
    async cancelExpiredUnboundSubmission(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(CANCEL_EXPIRED_UNBOUND_ATTEMPT_SQL)
          .bind(ulidSchema.parse(input.attemptId), ulidSchema.parse(input.jobId), timestamp),
        database
          .prepare(CANCEL_EXPIRED_UNBOUND_JOB_SQL)
          .bind(input.jobId, input.attemptId, timestamp),
        database
          .prepare(RECORD_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            "job_cancelled_unbound",
            timestamp,
          ),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async claimWinner(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(INSERT_SUBMISSION_SQL)
          .bind(
            runpodJobIdSchema.parse(input.runpodJobId),
            ulidSchema.parse(input.attemptId),
            "worker_claim",
            timestamp,
          ),
        database
          .prepare(CLAIM_WINNER_SQL)
          .bind(
            input.attemptId,
            input.jobId,
            input.runpodJobId,
            sha256HexSchema.parse(input.claimTokenHash),
            timestamp,
            sha256HexSchema.parse(input.heartbeatTokenHash),
            utcDateTimeSchema.parse(input.heartbeatExpiresAt),
          ),
        database
          .prepare(MARK_SUBMISSION_WINNER_SQL)
          .bind(input.runpodJobId, input.attemptId, timestamp),
        database.prepare(MARK_JOB_RUNNING_SQL).bind(input.jobId, input.attemptId, timestamp),
        database
          .prepare(RECORD_CLAIM_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            input.runpodJobId,
            timestamp,
          ),
      ]);
      return updatedIdRowsSchema.parse(results[1]?.results ?? [])[0] !== undefined;
    },

    async findClaimContext(attemptId, jobId) {
      const untrusted = await database
        .withSession("first-primary")
        .prepare(FIND_CLAIM_CONTEXT_SQL)
        .bind(ulidSchema.parse(attemptId), ulidSchema.parse(jobId))
        .first();
      return untrusted === null
        ? undefined
        : mapClaimContext(claimContextRowSchema.parse(untrusted));
    },

    async findDispatchablePendingJobId() {
      const untrusted = await database
        .withSession("first-primary")
        .prepare(FIND_DISPATCHABLE_PENDING_JOB_SQL)
        .first();
      return untrusted === null ? undefined : pendingJobRowSchema.parse(untrusted).id;
    },

    async findExpiredUnknownSubmissions(timestamp, limit) {
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_EXPIRED_UNKNOWN_SUBMISSIONS_SQL)
        .bind(utcDateTimeSchema.parse(timestamp), reconciliationLimitSchema.parse(limit))
        .all();
      return z
        .array(expiredUnknownSubmissionRowSchema)
        .max(limit)
        .parse(results.results)
        .map((row) => ({
          attemptId: row.attempt_id,
          claimExpiresAt: row.claim_expires_at,
          jobId: row.job_id,
        }));
    },

    async findExpiredUnboundCancellations(timestamp, limit) {
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_EXPIRED_UNBOUND_CANCELLATIONS_SQL)
        .bind(utcDateTimeSchema.parse(timestamp), reconciliationLimitSchema.parse(limit))
        .all();
      return z
        .array(expiredUnknownSubmissionRowSchema)
        .max(limit)
        .parse(results.results)
        .map((row) => ({
          attemptId: row.attempt_id,
          claimExpiresAt: row.claim_expires_at,
          jobId: row.job_id,
        }));
    },

    async findFailedUnclaimedSubmissions(limit) {
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_FAILED_UNCLAIMED_SUBMISSIONS_SQL)
        .bind(reconciliationLimitSchema.parse(limit))
        .all();
      return z
        .array(staleAcceptedSubmissionRowSchema)
        .max(limit)
        .parse(results.results)
        .map(mapStaleAcceptedSubmission);
    },

    async findStaleAcceptedSubmissions(staleBefore, limit) {
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_STALE_ACCEPTED_SUBMISSIONS_SQL)
        .bind(utcDateTimeSchema.parse(staleBefore), reconciliationLimitSchema.parse(limit))
        .all();
      return z
        .array(staleAcceptedSubmissionRowSchema)
        .max(limit)
        .parse(results.results)
        .map(mapStaleAcceptedSubmission);
    },

    async failStaleAcceptedSubmission(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const staleBefore = utcDateTimeSchema.parse(input.staleBefore);
      const runpodJobId = runpodJobIdSchema.parse(input.runpodJobId);
      const results = await database.batch([
        database
          .prepare(FAIL_STALE_ACCEPTED_ATTEMPT_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            ulidSchema.parse(input.jobId),
            timestamp,
            runpodJobId,
            staleBefore,
          ),
        database
          .prepare(FAIL_STALE_ACCEPTED_JOB_SQL)
          .bind(input.jobId, input.attemptId, timestamp, runpodJobId, staleBefore),
        database
          .prepare(RECORD_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            "runpod_submission_start_slo_exceeded",
            timestamp,
          ),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async failExpiredUnknownSubmission(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(FAIL_EXPIRED_UNKNOWN_ATTEMPT_SQL)
          .bind(ulidSchema.parse(input.attemptId), ulidSchema.parse(input.jobId), timestamp),
        database
          .prepare(FAIL_EXPIRED_UNKNOWN_JOB_SQL)
          .bind(input.jobId, input.attemptId, timestamp),
        database
          .prepare(RECORD_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            "runpod_submission_expired",
            timestamp,
          ),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async markFailedUnclaimedSubmissionCancelled(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const runpodJobId = runpodJobIdSchema.parse(input.runpodJobId);
      const results = await database.batch([
        database
          .prepare(MARK_FAILED_UNCLAIMED_SUBMISSION_CANCELLED_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            ulidSchema.parse(input.jobId),
            runpodJobId,
            timestamp,
          ),
        database
          .prepare(RECORD_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            "runpod_stale_submission_cancelled",
            timestamp,
          ),
      ]);
      return updatedIdRowsSchema.parse(results[0]?.results ?? [])[0] !== undefined;
    },

    async markHeartbeat(input) {
      const results = await database
        .prepare(HEARTBEAT_SQL)
        .bind(
          ulidSchema.parse(input.attemptId),
          ulidSchema.parse(input.jobId),
          runpodJobIdSchema.parse(input.runpodJobId),
          sha256HexSchema.parse(input.heartbeatTokenHash),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },

    async prepareSubmission(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const claimTokenHash = sha256HexSchema.parse(input.claimTokenHash);
      const results = await database.batch([
        database
          .prepare(PREPARE_SUBMISSION_SQL)
          .bind(
            ulidSchema.parse(input.jobId),
            claimTokenHash,
            timestamp,
            utcDateTimeSchema.parse(input.claimExpiresAt),
          ),
        database.prepare(MARK_JOB_SUBMITTING_SQL).bind(input.jobId, timestamp, claimTokenHash),
      ]);
      const prepared = updatedAttemptRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      if (prepared === undefined || updatedJob === undefined) {
        return undefined;
      }
      return {
        attemptId: prepared.id,
        generation: prepared.generation,
        jobId: prepared.job_id,
      };
    },

    async recordClaimSubmission(input) {
      await database
        .prepare(INSERT_SUBMISSION_SQL)
        .bind(
          runpodJobIdSchema.parse(input.runpodJobId),
          ulidSchema.parse(input.attemptId),
          "worker_claim",
          utcDateTimeSchema.parse(input.timestamp),
        )
        .run();
    },

    async recordSubmissionAccepted(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(INSERT_SUBMISSION_SQL)
          .bind(
            runpodJobIdSchema.parse(input.runpodJobId),
            ulidSchema.parse(input.attemptId),
            "submit_response",
            timestamp,
          ),
        database
          .prepare(MARK_SUBMISSION_ACCEPTED_SQL)
          .bind(input.attemptId, timestamp, input.runpodJobId),
      ]);
      return updatedIdRowsSchema.parse(results[1]?.results ?? [])[0] !== undefined;
    },

    async recordSubmissionRejected(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database
          .prepare(MARK_ATTEMPT_REJECTED_SQL)
          .bind(ulidSchema.parse(input.attemptId), timestamp),
        database
          .prepare(MARK_JOB_REJECTED_SQL)
          .bind(ulidSchema.parse(input.jobId), timestamp, input.attemptId),
        database
          .prepare(RECORD_EVENT_SQL)
          .bind(
            ulidSchema.parse(input.eventId),
            input.jobId,
            input.attemptId,
            "runpod_submission_rejected",
            timestamp,
          ),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async recordSubmissionUnknown(attemptId, timestamp) {
      const results = await database
        .prepare(MARK_SUBMISSION_UNKNOWN_SQL)
        .bind(ulidSchema.parse(attemptId), utcDateTimeSchema.parse(timestamp))
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },
  };
}
