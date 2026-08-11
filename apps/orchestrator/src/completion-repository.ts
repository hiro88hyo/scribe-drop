import {
  MAX_RECORDING_DURATION_SECONDS,
  outputFormatSchema,
  publicErrorCodeSchema,
  runpodJobIdSchema,
  runpodStatusValueSchema,
  runpodWorkerErrorCodeSchema,
  ulidSchema,
  utcDateTimeSchema,
  type OutputFormat,
  type PublicErrorCode,
  type RunpodStatus,
  type RunpodWorkerErrorCode,
  type RunpodWorkerOutput,
} from "@scribe-drop/contracts";
import { z } from "zod";

const TERMINAL_RUNPOD_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;
const terminalRunpodStatusSchema = z.enum(TERMINAL_RUNPOD_STATUSES);
const resultPrefixSchema = z.string().min(1).max(900).startsWith("results/").endsWith("/");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const reconciliationLimitSchema = z.number().int().min(1).max(100);
const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);

const PROVIDER_COMPATIBILITY_PREDICATE = `
  (
    (
      attempts.provider_kind IS NULL
      AND executions.id IS NULL
    )
    OR (
      executions.id = attempts.id
      AND executions.provider_kind = attempts.provider_kind
      AND executions.provider_policy = attempts.provider_policy
      AND executions.status = CASE attempts.status
        WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
        WHEN 'SUBMITTING' THEN 'CREATING'
        WHEN 'RUNNING' THEN 'RUNNING'
        WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
        ELSE 'TERMINAL'
      END
      AND executions.create_outcome IS attempts.submission_outcome
      AND executions.provider_handle IS attempts.winning_runpod_job_id
      AND executions.terminal_status IS attempts.runpod_terminal_status
    )
  )
`;

const UPDATE_PROVIDER_COMPATIBILITY_PREDICATE = `
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
        AND executions.id = job_attempts.id
        AND executions.provider_kind = job_attempts.provider_kind
        AND executions.provider_policy = job_attempts.provider_policy
        AND executions.status = CASE job_attempts.status
          WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
          WHEN 'SUBMITTING' THEN 'CREATING'
          WHEN 'RUNNING' THEN 'RUNNING'
          WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
          ELSE 'TERMINAL'
        END
        AND executions.create_outcome IS job_attempts.submission_outcome
        AND executions.provider_handle IS job_attempts.winning_runpod_job_id
        AND executions.terminal_status IS job_attempts.runpod_terminal_status
    )
  )
`;

const FIND_STATUS_POLL_CANDIDATES_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.status AS attempt_status,
    attempts.claimed_at,
    attempts.heartbeat_at,
    attempts.submission_started_at,
    jobs.status AS job_status,
    submissions.runpod_job_id
  FROM jobs
  INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
  INNER JOIN runpod_submissions AS submissions ON submissions.attempt_id = attempts.id
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND jobs.deleted_at IS NULL
    AND attempts.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND attempts.runpod_terminal_status IS NULL
    AND ${PROVIDER_COMPATIBILITY_PREDICATE}
    AND (
      (
        attempts.winning_runpod_job_id IS NOT NULL
        AND submissions.runpod_job_id = attempts.winning_runpod_job_id
      )
      OR (
        attempts.winning_runpod_job_id IS NULL
        AND submissions.source = 'submit_response'
      )
    )
  ORDER BY attempts.updated_at, attempts.id
  LIMIT ?1
`;

const FAIL_UNOBSERVABLE_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'FAILED',
    error_code = 'PROCESSING_FAILED',
    error_message = NULL,
    heartbeat_revoked_at = CASE
      WHEN heartbeat_token_hash IS NULL THEN NULL
      ELSE ?5
    END,
    failed_at = ?5,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND runpod_terminal_status IS NULL
    AND ${UPDATE_PROVIDER_COMPATIBILITY_PREDICATE}
    AND (
      (
        ?6 = 'submission'
        AND submission_started_at <= ?4
      )
      OR (
        ?6 = 'execution'
        AND claimed_at IS NOT NULL
        AND claimed_at <= ?4
      )
    )
    AND (
      winning_runpod_job_id = ?3
      OR (
        winning_runpod_job_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM runpod_submissions
          WHERE attempt_id = ?1
            AND runpod_job_id = ?3
            AND source = 'submit_response'
        )
      )
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const RECORD_TERMINAL_STATUS_SQL = `
  UPDATE job_attempts
  SET
    runpod_terminal_job_id = ?3,
    runpod_terminal_status = ?4,
    runpod_terminal_observed_at = ?5,
    runpod_output_status = ?6,
    runpod_output_error_code = ?7,
    runpod_manifest_written = ?8,
    detected_language = ?9,
    segment_count = ?10,
    runpod_delay_ms = ?11,
    runpod_execution_ms = ?12,
    media_duration_seconds = ?13,
    updated_at = ?5
  WHERE id = ?1
    AND job_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND runpod_terminal_status IS NULL
    AND ${UPDATE_PROVIDER_COMPATIBILITY_PREDICATE}
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
        AND deleted_at IS NULL
    )
    AND (
      winning_runpod_job_id = ?3
      OR (
        winning_runpod_job_id IS NULL
        AND ?14 = 1
        AND EXISTS (
          SELECT 1
          FROM runpod_submissions
          WHERE attempt_id = ?1
            AND runpod_job_id = ?3
            AND source = 'submit_response'
        )
      )
    )
  RETURNING id
`;

const FIND_TERMINAL_OUTCOMES_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.job_id,
    attempts.generation,
    attempts.result_prefix,
    attempts.winning_runpod_job_id,
    attempts.runpod_terminal_job_id,
    attempts.runpod_terminal_status,
    attempts.runpod_terminal_observed_at,
    attempts.runpod_output_status,
    attempts.runpod_output_error_code,
    attempts.runpod_manifest_written,
    attempts.detected_language,
    attempts.segment_count,
    attempts.media_duration_seconds,
    attempts.runpod_execution_ms,
    jobs.status AS job_status
  FROM jobs
  INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE jobs.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND jobs.deleted_at IS NULL
    AND attempts.status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND attempts.runpod_terminal_status IS NOT NULL
    AND attempts.runpod_terminal_observed_at IS NOT NULL
    AND ${PROVIDER_COMPATIBILITY_PREDICATE}
  ORDER BY attempts.runpod_terminal_observed_at, attempts.id
  LIMIT ?1
`;

const FINALIZE_TERMINAL_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = ?4,
    error_code = ?5,
    error_message = NULL,
    heartbeat_revoked_at = CASE
      WHEN heartbeat_token_hash IS NULL THEN NULL
      ELSE ?6
    END,
    completed_at = CASE WHEN ?4 = 'COMPLETED' THEN ?6 ELSE completed_at END,
    failed_at = CASE WHEN ?4 = 'FAILED' THEN ?6 ELSE failed_at END,
    updated_at = ?6
  WHERE id = ?1
    AND job_id = ?2
    AND runpod_terminal_job_id = ?3
    AND runpod_terminal_status IS NOT NULL
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ${UPDATE_PROVIDER_COMPATIBILITY_PREDICATE}
    AND (
      winning_runpod_job_id = ?3
      OR (
        winning_runpod_job_id IS NULL
        AND ?4 IN ('FAILED', 'CANCELLED')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM jobs
      WHERE id = ?2
        AND active_attempt_id = ?1
        AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
        AND deleted_at IS NULL
    )
  RETURNING id
`;

const FINALIZE_TERMINAL_JOB_SQL = `
  UPDATE jobs
  SET
    status = ?3,
    error_code = ?4,
    error_message = NULL,
    completed_at = CASE WHEN ?3 = 'COMPLETED' THEN ?5 ELSE completed_at END,
    failed_at = CASE WHEN ?3 = 'FAILED' THEN ?5 ELSE failed_at END,
    cancelled_at = CASE WHEN ?3 = 'CANCELLED' THEN ?5 ELSE cancelled_at END,
    duration_seconds = CASE WHEN ?3 = 'COMPLETED' THEN ?6 ELSE duration_seconds END,
    updated_at = ?5,
    version = version + 1
  WHERE id = ?1
    AND active_attempt_id = ?2
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM job_attempts
      WHERE id = ?2
        AND job_id = ?1
        AND status = ?3
        AND updated_at = ?5
    )
  RETURNING id
`;

const INSERT_ARTIFACT_SQL = `
  INSERT INTO job_artifacts (
    job_id,
    attempt_id,
    format,
    object_key,
    size_bytes,
    sha256,
    created_at
  )
  SELECT
    ?1,
    ?2,
    ?3,
    ?4,
    ?5,
    ?6,
    ?7
  FROM jobs
  INNER JOIN job_attempts ON job_attempts.id = jobs.active_attempt_id
  WHERE jobs.id = ?1
    AND jobs.status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND jobs.deleted_at IS NULL
    AND job_attempts.id = ?2
    AND job_attempts.job_id = jobs.id
    AND job_attempts.status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND job_attempts.winning_runpod_job_id = ?8
    AND job_attempts.runpod_terminal_job_id = ?8
    AND job_attempts.runpod_terminal_status = 'COMPLETED'
    AND job_attempts.runpod_output_status = 'completed'
    AND job_attempts.runpod_manifest_written = 1
    AND ${UPDATE_PROVIDER_COMPATIBILITY_PREDICATE}
  ON CONFLICT(attempt_id, format) DO NOTHING
`;

const COMPLETE_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'COMPLETED',
    heartbeat_revoked_at = CASE
      WHEN heartbeat_token_hash IS NULL THEN NULL
      ELSE ?4
    END,
    completed_at = ?4,
    error_code = NULL,
    error_message = NULL,
    updated_at = ?4
  WHERE id = ?1
    AND job_id = ?2
    AND status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND winning_runpod_job_id = ?3
    AND runpod_terminal_job_id = ?3
    AND runpod_terminal_status = 'COMPLETED'
    AND runpod_output_status = 'completed'
    AND runpod_manifest_written = 1
    AND ${UPDATE_PROVIDER_COMPATIBILITY_PREDICATE}
    AND EXISTS (
      SELECT 1
      FROM job_artifacts
      WHERE job_id = ?2
        AND attempt_id = ?1
        AND format = 'markdown'
        AND object_key = ?5
        AND size_bytes = ?6
        AND sha256 = ?7
    )
    AND EXISTS (
      SELECT 1
      FROM job_artifacts
      WHERE job_id = ?2
        AND attempt_id = ?1
        AND format = 'json'
        AND object_key = ?8
        AND size_bytes = ?9
        AND sha256 = ?10
    )
    AND EXISTS (
      SELECT 1
      FROM job_artifacts
      WHERE job_id = ?2
        AND attempt_id = ?1
        AND format = 'srt'
        AND object_key = ?11
        AND size_bytes = ?12
        AND sha256 = ?13
    )
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

const INSERT_NOTIFICATION_SQL = `
  INSERT INTO notification_outbox (
    id,
    job_id,
    job_version,
    status,
    attempt_count,
    next_attempt_at,
    last_error,
    created_at,
    sent_at
  )
  SELECT
    ?1,
    ?2,
    (
      SELECT version
      FROM jobs
      WHERE id = ?2
    ),
    'PENDING',
    0,
    ?3,
    NULL,
    ?3,
    NULL
  FROM job_attempts AS attempts
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE attempts.id = ?4
    AND attempts.job_id = ?2
    AND attempts.status = 'COMPLETED'
    AND ${PROVIDER_COMPATIBILITY_PREDICATE}
    AND completed_at = ?3
  ON CONFLICT(job_id) DO UPDATE SET
    job_version = excluded.job_version,
    status = 'PENDING',
    attempt_count = 0,
    next_attempt_at = excluded.next_attempt_at,
    last_error = NULL,
    created_at = excluded.created_at,
    sent_at = NULL
  WHERE notification_outbox.job_version IS NOT excluded.job_version
    OR notification_outbox.status IN ('SENT', 'DEAD')
`;

const RECORD_COMPLETION_EVENT_SQL = `
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
    'job_completed',
    'orchestrator',
    NULL,
    ?4
  FROM jobs
  WHERE id = ?2
    AND active_attempt_id = ?3
    AND status = 'COMPLETED'
    AND completed_at = ?4
  ON CONFLICT(id) DO NOTHING
`;

const RECORD_RECONCILIATION_FAILURE_EVENT_SQL = `
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
    'job_reconciliation_expired',
    'orchestrator',
    NULL,
    ?4
  FROM jobs
  WHERE id = ?2
    AND active_attempt_id = ?3
    AND status = 'FAILED'
    AND failed_at = ?4
  ON CONFLICT(id) DO NOTHING
`;

const pollCandidateRowSchema = z
  .object({
    attempt_id: ulidSchema,
    attempt_status: z.enum(["SUBMITTING", "RUNNING", "CANCEL_REQUESTED"]),
    claimed_at: utcDateTimeSchema.nullable(),
    heartbeat_at: utcDateTimeSchema.nullable(),
    job_id: ulidSchema,
    job_status: z.enum(["SUBMITTING", "RUNNING", "CANCEL_REQUESTED"]),
    runpod_job_id: runpodJobIdSchema,
    submission_started_at: utcDateTimeSchema,
  })
  .strict();

const terminalOutcomeRowSchema = z
  .object({
    attempt_id: ulidSchema,
    detected_language: z.string().min(2).max(35).nullable(),
    media_duration_seconds: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS).nullable(),
    generation: z.number().int().positive(),
    job_id: ulidSchema,
    job_status: z.enum(["SUBMITTING", "RUNNING", "CANCEL_REQUESTED"]),
    result_prefix: resultPrefixSchema,
    runpod_execution_ms: z.number().int().nonnegative().nullable(),
    runpod_manifest_written: z.union([z.literal(0), z.literal(1)]).nullable(),
    runpod_output_error_code: runpodWorkerErrorCodeSchema.nullable(),
    runpod_output_status: z.enum(["completed", "failed", "cancelled", "deduplicated"]).nullable(),
    runpod_terminal_job_id: runpodJobIdSchema,
    runpod_terminal_observed_at: utcDateTimeSchema,
    runpod_terminal_status: terminalRunpodStatusSchema,
    segment_count: z.number().int().nonnegative().nullable(),
    winning_runpod_job_id: runpodJobIdSchema.nullable(),
  })
  .strict();

export interface StatusPollCandidate {
  readonly attemptId: string;
  readonly attemptStatus: "CANCEL_REQUESTED" | "RUNNING" | "SUBMITTING";
  readonly claimedAt: string | null;
  readonly heartbeatAt: string | null;
  readonly jobId: string;
  readonly jobStatus: "CANCEL_REQUESTED" | "RUNNING" | "SUBMITTING";
  readonly runpodJobId: string;
  readonly submissionStartedAt: string;
}

export interface TerminalOutcome {
  readonly attemptId: string;
  readonly detectedLanguage: string | null;
  readonly durationSeconds: number | null;
  readonly generation: number;
  readonly jobId: string;
  readonly jobStatus: "CANCEL_REQUESTED" | "RUNNING" | "SUBMITTING";
  readonly resultPrefix: string;
  readonly runpodExecutionMs: number | null;
  readonly runpodManifestWritten: boolean | null;
  readonly runpodOutputErrorCode: RunpodWorkerErrorCode | null;
  readonly runpodOutputStatus: "cancelled" | "completed" | "deduplicated" | "failed" | null;
  readonly runpodTerminalJobId: string;
  readonly runpodTerminalObservedAt: string;
  readonly runpodTerminalStatus: (typeof TERMINAL_RUNPOD_STATUSES)[number];
  readonly segmentCount: number | null;
  readonly winningRunpodJobId: string | null;
}

export interface VerifiedArtifact {
  readonly format: OutputFormat;
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface CompletionRepository {
  failUnobservableAttempt(input: {
    readonly attemptId: string;
    readonly cutoff: string;
    readonly deadline: "execution" | "submission";
    readonly eventId: string;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  finalizeCompleted(input: {
    readonly artifacts: readonly [VerifiedArtifact, VerifiedArtifact, VerifiedArtifact];
    readonly attemptId: string;
    readonly durationSeconds: number;
    readonly eventId: string;
    readonly jobId: string;
    readonly notificationId: string;
    readonly runpodJobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  finalizeTerminal(input: {
    readonly attemptId: string;
    readonly errorCode: PublicErrorCode | null;
    readonly jobId: string;
    readonly runpodJobId: string;
    readonly status: "CANCELLED" | "FAILED";
    readonly timestamp: string;
  }): Promise<boolean>;
  findStatusPollCandidates(limit: number): Promise<readonly StatusPollCandidate[]>;
  findTerminalOutcomes(limit: number): Promise<readonly TerminalOutcome[]>;
  recordTerminalStatus(input: {
    readonly attemptId: string;
    readonly delayTime: number | null;
    readonly executionTime: number | null;
    readonly jobId: string;
    readonly output: RunpodWorkerOutput | null;
    readonly runpodJobId: string;
    readonly status: RunpodStatus;
    readonly timestamp: string;
  }): Promise<boolean>;
}

function mapTerminalOutcome(row: z.infer<typeof terminalOutcomeRowSchema>): TerminalOutcome {
  return {
    attemptId: row.attempt_id,
    detectedLanguage: row.detected_language,
    durationSeconds: row.media_duration_seconds,
    generation: row.generation,
    jobId: row.job_id,
    jobStatus: row.job_status,
    resultPrefix: row.result_prefix,
    runpodExecutionMs: row.runpod_execution_ms,
    runpodManifestWritten:
      row.runpod_manifest_written === null ? null : row.runpod_manifest_written === 1,
    runpodOutputErrorCode: row.runpod_output_error_code,
    runpodOutputStatus: row.runpod_output_status,
    runpodTerminalJobId: row.runpod_terminal_job_id,
    runpodTerminalObservedAt: row.runpod_terminal_observed_at,
    runpodTerminalStatus: row.runpod_terminal_status,
    segmentCount: row.segment_count,
    winningRunpodJobId: row.winning_runpod_job_id,
  };
}

export function createD1CompletionRepository(database: D1Database): CompletionRepository {
  return {
    async failUnobservableAttempt(input) {
      const results = await database.batch([
        database
          .prepare(FAIL_UNOBSERVABLE_ATTEMPT_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            ulidSchema.parse(input.jobId),
            runpodJobIdSchema.parse(input.runpodJobId),
            utcDateTimeSchema.parse(input.cutoff),
            utcDateTimeSchema.parse(input.timestamp),
            z.enum(["execution", "submission"]).parse(input.deadline),
          ),
        database
          .prepare(FINALIZE_TERMINAL_JOB_SQL)
          .bind(input.jobId, input.attemptId, "FAILED", "PROCESSING_FAILED", input.timestamp, null),
        database
          .prepare(RECORD_RECONCILIATION_FAILURE_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), input.jobId, input.attemptId, input.timestamp),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async finalizeCompleted(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const attemptId = ulidSchema.parse(input.attemptId);
      const jobId = ulidSchema.parse(input.jobId);
      const runpodJobId = runpodJobIdSchema.parse(input.runpodJobId);
      const durationSeconds = z
        .number()
        .nonnegative()
        .max(MAX_RECORDING_DURATION_SECONDS)
        .parse(input.durationSeconds);
      const parsedArtifacts = input.artifacts.map((artifact) => ({
        format: outputFormatSchema.parse(artifact.format),
        key: z.string().min(1).max(1024).startsWith("results/").parse(artifact.key),
        sha256: sha256Schema.parse(artifact.sha256),
        sizeBytes: z.number().int().min(0).max(2_147_483_648).parse(artifact.sizeBytes),
      }));
      if (
        parsedArtifacts.length !== 3 ||
        new Set(parsedArtifacts.map((artifact) => artifact.format)).size !== 3
      ) {
        throw new Error("Completion requires three distinct artifacts");
      }
      const markdown = parsedArtifacts.find((artifact) => artifact.format === "markdown");
      const json = parsedArtifacts.find((artifact) => artifact.format === "json");
      const srt = parsedArtifacts.find((artifact) => artifact.format === "srt");
      if (markdown === undefined || json === undefined || srt === undefined) {
        throw new Error("Completion requires markdown, JSON, and SRT artifacts");
      }
      const artifacts = [markdown, json, srt] as const;
      const results = await database.batch([
        ...artifacts.map((artifact) =>
          database
            .prepare(INSERT_ARTIFACT_SQL)
            .bind(
              jobId,
              attemptId,
              artifact.format,
              artifact.key,
              artifact.sizeBytes,
              artifact.sha256,
              timestamp,
              runpodJobId,
            ),
        ),
        database
          .prepare(COMPLETE_ATTEMPT_SQL)
          .bind(
            attemptId,
            jobId,
            runpodJobId,
            timestamp,
            markdown.key,
            markdown.sizeBytes,
            markdown.sha256,
            json.key,
            json.sizeBytes,
            json.sha256,
            srt.key,
            srt.sizeBytes,
            srt.sha256,
          ),
        database
          .prepare(FINALIZE_TERMINAL_JOB_SQL)
          .bind(jobId, attemptId, "COMPLETED", null, timestamp, durationSeconds),
        database
          .prepare(INSERT_NOTIFICATION_SQL)
          .bind(ulidSchema.parse(input.notificationId), jobId, timestamp, attemptId),
        database
          .prepare(RECORD_COMPLETION_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), jobId, attemptId, timestamp),
      ]);
      const completedAttempt = updatedIdRowsSchema.parse(results[3]?.results ?? [])[0];
      const completedJob = updatedIdRowsSchema.parse(results[4]?.results ?? [])[0];
      return completedAttempt !== undefined && completedJob !== undefined;
    },

    async finalizeTerminal(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const status = z.enum(["CANCELLED", "FAILED"]).parse(input.status);
      const errorCode =
        input.errorCode === null ? null : publicErrorCodeSchema.parse(input.errorCode);
      if ((status === "FAILED") !== (errorCode !== null)) {
        throw new Error("Terminal failure requires an error code and cancellation forbids one");
      }
      const results = await database.batch([
        database
          .prepare(FINALIZE_TERMINAL_ATTEMPT_SQL)
          .bind(
            ulidSchema.parse(input.attemptId),
            ulidSchema.parse(input.jobId),
            runpodJobIdSchema.parse(input.runpodJobId),
            status,
            errorCode,
            timestamp,
          ),
        database
          .prepare(FINALIZE_TERMINAL_JOB_SQL)
          .bind(input.jobId, input.attemptId, status, errorCode, timestamp, null),
      ]);
      const updatedAttempt = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedAttempt !== undefined && updatedJob !== undefined;
    },

    async findStatusPollCandidates(limit) {
      const parsedLimit = reconciliationLimitSchema.parse(limit);
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_STATUS_POLL_CANDIDATES_SQL)
        .bind(parsedLimit)
        .all();
      return z
        .array(pollCandidateRowSchema)
        .max(parsedLimit)
        .parse(results.results)
        .map((row) => ({
          attemptId: row.attempt_id,
          attemptStatus: row.attempt_status,
          claimedAt: row.claimed_at,
          heartbeatAt: row.heartbeat_at,
          jobId: row.job_id,
          jobStatus: row.job_status,
          runpodJobId: row.runpod_job_id,
          submissionStartedAt: row.submission_started_at,
        }));
    },

    async findTerminalOutcomes(limit) {
      const parsedLimit = reconciliationLimitSchema.parse(limit);
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_TERMINAL_OUTCOMES_SQL)
        .bind(parsedLimit)
        .all();
      return z
        .array(terminalOutcomeRowSchema)
        .max(parsedLimit)
        .parse(results.results)
        .map(mapTerminalOutcome);
    },

    async recordTerminalStatus(input) {
      const status = runpodStatusValueSchema.parse(input.status);
      if (!terminalRunpodStatusSchema.safeParse(status).success) {
        throw new Error("Only terminal RunPod statuses can be recorded");
      }
      const output = input.output;
      const allowUnclaimedTerminal =
        status !== "COMPLETED" || (output !== null && output.status !== "completed");
      const results = await database
        .prepare(RECORD_TERMINAL_STATUS_SQL)
        .bind(
          ulidSchema.parse(input.attemptId),
          ulidSchema.parse(input.jobId),
          runpodJobIdSchema.parse(input.runpodJobId),
          status,
          utcDateTimeSchema.parse(input.timestamp),
          output?.status ?? null,
          output !== null && "errorCode" in output ? output.errorCode : null,
          output?.manifestWritten === undefined ? null : output.manifestWritten ? 1 : 0,
          output !== null && "detectedLanguage" in output ? output.detectedLanguage : null,
          output !== null && "segmentCount" in output ? output.segmentCount : null,
          input.delayTime,
          input.executionTime,
          output !== null && "durationSeconds" in output ? output.durationSeconds : null,
          allowUnclaimedTerminal ? 1 : 0,
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },
  };
}
