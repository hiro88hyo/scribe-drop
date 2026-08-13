import {
  MAX_RECORDING_DURATION_SECONDS,
  boundedResultManifestSchema,
  cloudRunOpaqueHandleSchema,
  publicErrorCodeSchema,
  ulidSchema,
  utcDateTimeSchema,
  type BoundedResultManifest,
  type CloudRunTerminalRequest,
  type PublicErrorCode,
} from "@scribe-drop/contracts";
import { z } from "zod";

const mutationRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);
const terminalStateRowSchema = z
  .object({
    attempt_status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
    job_status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
  })
  .strict();

const TERMINAL_EVENT_PREDICATE = `
  EXISTS (
    SELECT 1
    FROM cloud_run_runtime_events AS events
    INNER JOIN cloud_run_runtime_bootstraps AS bootstraps
      ON bootstraps.bootstrap_request_id = events.bootstrap_request_id
    WHERE bootstraps.execution_id = provider_executions.id
      AND bootstraps.execution_handle = ?3
      AND events.kind = 'terminal'
      AND events.terminal_status = ?4
      AND events.artifact_count = ?5
      AND events.duration_seconds = ?6
      AND events.manifest_written = ?7
      AND events.segment_count = ?8
  )
`;

const INSERT_ARTIFACT_SQL = `
  INSERT INTO job_artifacts (
    job_id, attempt_id, format, object_key, size_bytes, sha256, created_at
  )
  SELECT ?2, ?1, ?9, ?10, ?11, ?12, ?13
  FROM provider_executions
  WHERE attempt_id = ?1
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND provider_handle = ?3
    AND status IN ('CREATING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ${TERMINAL_EVENT_PREDICATE}
  ON CONFLICT(attempt_id, format) DO NOTHING
`;

const COMPLETE_EXECUTION_SQL = `
  UPDATE provider_executions
  SET
    status = 'TERMINAL',
    create_outcome = 'accepted',
    terminal_status = 'COMPLETED',
    cleanup_status = CASE
      WHEN cleanup_status = 'NOT_REQUESTED' THEN 'PENDING'
      ELSE cleanup_status
    END,
    version = version + 1,
    updated_at = ?9
  WHERE attempt_id = ?1
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND provider_handle = ?3
    AND status IN ('CREATING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ?4 = 'succeeded'
    AND ${TERMINAL_EVENT_PREDICATE}
    AND (
      SELECT COUNT(*) FROM job_artifacts
      WHERE attempt_id = ?1
    ) = ?5
  RETURNING id
`;

const COMPLETE_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = 'COMPLETED',
    completed_at = ?9,
    media_duration_seconds = ?6,
    segment_count = ?8,
    error_code = NULL,
    error_message = NULL,
    updated_at = ?9
  WHERE id = ?1
    AND job_id = ?2
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1
        AND provider_handle = ?3
        AND status = 'TERMINAL'
        AND terminal_status = 'COMPLETED'
    )
  RETURNING id
`;

const FINALIZE_JOB_SQL = `
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
      SELECT 1 FROM job_attempts
      WHERE id = ?2 AND job_id = ?1 AND status = ?3 AND updated_at = ?5
    )
  RETURNING id
`;

const INSERT_NOTIFICATION_SQL = `
  INSERT INTO notification_outbox (
    id, job_id, job_version, status, attempt_count, next_attempt_at,
    last_error, created_at, sent_at
  )
  SELECT ?1, jobs.id, jobs.version, 'PENDING', 0, ?3, NULL, ?3, NULL
  FROM jobs
  WHERE jobs.id = ?2 AND jobs.status = 'COMPLETED' AND jobs.updated_at = ?3
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

const INSERT_COMPLETION_EVENT_SQL = `
  INSERT INTO job_events (id, job_id, attempt_id, event_type, actor, metadata_json, created_at)
  SELECT ?1, ?2, ?3, 'job_completed', 'orchestrator', NULL, ?4
  FROM jobs
  WHERE id = ?2 AND active_attempt_id = ?3 AND status = 'COMPLETED' AND updated_at = ?4
  ON CONFLICT(id) DO NOTHING
`;

const TERMINATE_EXECUTION_SQL = `
  UPDATE provider_executions
  SET
    status = 'TERMINAL',
    create_outcome = COALESCE(create_outcome, 'accepted'),
    terminal_status = ?9,
    cleanup_status = CASE
      WHEN cleanup_status = 'NOT_REQUESTED' THEN 'PENDING'
      ELSE cleanup_status
    END,
    version = version + 1,
    updated_at = ?10
  WHERE attempt_id = ?1
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND provider_handle = ?3
    AND status IN ('CREATING', 'RUNNING', 'CANCEL_REQUESTED')
    AND ${TERMINAL_EVENT_PREDICATE}
  RETURNING id
`;

const TERMINATE_ATTEMPT_SQL = `
  UPDATE job_attempts
  SET
    status = ?4,
    error_code = ?5,
    error_message = NULL,
    failed_at = CASE WHEN ?4 = 'FAILED' THEN ?6 ELSE failed_at END,
    updated_at = ?6
  WHERE id = ?1
    AND job_id = ?2
    AND provider_kind = 'cloud_run_jobs'
    AND provider_policy = 'cloud_run_jobs_l4_v1'
    AND status IN ('SUBMITTING', 'RUNNING', 'CANCEL_REQUESTED')
    AND EXISTS (
      SELECT 1 FROM provider_executions
      WHERE attempt_id = ?1
        AND provider_handle = ?3
        AND status = 'TERMINAL'
        AND terminal_status = ?7
    )
  RETURNING id
`;

export interface CloudRunTerminalRepository {
  finalizeFailure(input: CloudRunTerminalFinalizationInput): Promise<boolean>;
  finalizeSuccess(
    input: CloudRunTerminalFinalizationInput & { readonly manifest: BoundedResultManifest },
  ): Promise<boolean>;
}

export interface CloudRunTerminalFinalizationInput {
  readonly attemptId: string;
  readonly eventId: string;
  readonly executionHandle: string;
  readonly jobId: string;
  readonly notificationId: string;
  readonly request: CloudRunTerminalRequest;
  readonly timestamp: string;
}

function common(input: CloudRunTerminalFinalizationInput): readonly unknown[] {
  return [
    ulidSchema.parse(input.attemptId),
    ulidSchema.parse(input.jobId),
    cloudRunOpaqueHandleSchema.parse(input.executionHandle),
    input.request.status,
    input.request.artifactCount,
    z
      .number()
      .nonnegative()
      .max(MAX_RECORDING_DURATION_SECONDS)
      .parse(input.request.durationSeconds),
    input.request.manifestWritten ? 1 : 0,
    z.number().int().nonnegative().max(100_000).parse(input.request.segmentCount),
  ];
}

async function isFinalized(database: D1Database, attemptId: string): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `
        SELECT attempts.status AS attempt_status, jobs.status AS job_status
        FROM job_attempts AS attempts
        INNER JOIN jobs ON jobs.id = attempts.job_id
        WHERE attempts.id = ?1
          AND attempts.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
          AND jobs.status = attempts.status
      `,
    )
    .bind(ulidSchema.parse(attemptId))
    .first();
  if (row === null) return false;
  terminalStateRowSchema.parse(row);
  return true;
}

export function createD1CloudRunTerminalRepository(
  database: D1Database,
): CloudRunTerminalRepository {
  return {
    async finalizeSuccess(input) {
      const manifest = boundedResultManifestSchema.parse(input.manifest);
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const values = common(input);
      const artifacts = manifest.artifacts;
      const statements = artifacts.map((artifact) =>
        database
          .prepare(INSERT_ARTIFACT_SQL)
          .bind(
            ...values,
            artifact.format,
            artifact.key,
            artifact.sizeBytes,
            artifact.sha256,
            timestamp,
          ),
      );
      const completionIndex = statements.length;
      statements.push(
        database.prepare(COMPLETE_EXECUTION_SQL).bind(...values, timestamp),
        database.prepare(COMPLETE_ATTEMPT_SQL).bind(...values, timestamp),
        database
          .prepare(FINALIZE_JOB_SQL)
          .bind(
            input.jobId,
            input.attemptId,
            "COMPLETED",
            null,
            timestamp,
            input.request.durationSeconds,
          ),
        database
          .prepare(INSERT_NOTIFICATION_SQL)
          .bind(ulidSchema.parse(input.notificationId), input.jobId, timestamp),
        database
          .prepare(INSERT_COMPLETION_EVENT_SQL)
          .bind(ulidSchema.parse(input.eventId), input.jobId, input.attemptId, timestamp),
      );
      const results = await database.batch(statements);
      const execution = mutationRowsSchema.parse(results[completionIndex]?.results ?? [])[0];
      const attempt = mutationRowsSchema.parse(results[completionIndex + 1]?.results ?? [])[0];
      const job = mutationRowsSchema.parse(results[completionIndex + 2]?.results ?? [])[0];
      return execution !== undefined && attempt !== undefined && job !== undefined
        ? true
        : isFinalized(database, input.attemptId);
    },

    async finalizeFailure(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const values = common(input);
      const cancelled = input.request.status === "cancelled";
      const attemptStatus = cancelled ? "CANCELLED" : "FAILED";
      const providerStatus = cancelled ? "CANCELLED" : "FAILED";
      const errorCode: PublicErrorCode | null = cancelled
        ? null
        : publicErrorCodeSchema.parse("PROCESSING_FAILED");
      const results = await database.batch([
        database.prepare(TERMINATE_EXECUTION_SQL).bind(...values, providerStatus, timestamp),
        database
          .prepare(TERMINATE_ATTEMPT_SQL)
          .bind(
            input.attemptId,
            input.jobId,
            input.executionHandle,
            attemptStatus,
            errorCode,
            timestamp,
            providerStatus,
          ),
        database
          .prepare(FINALIZE_JOB_SQL)
          .bind(input.jobId, input.attemptId, attemptStatus, errorCode, timestamp, null),
      ]);
      const execution = mutationRowsSchema.parse(results[0]?.results ?? [])[0];
      const attempt = mutationRowsSchema.parse(results[1]?.results ?? [])[0];
      const job = mutationRowsSchema.parse(results[2]?.results ?? [])[0];
      return execution !== undefined && attempt !== undefined && job !== undefined
        ? true
        : isFinalized(database, input.attemptId);
    },
  };
}
