import { MAX_JOB_TITLE_LENGTH, ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { z } from "zod";

export const NOTIFICATION_ERROR_CODES = [
  "CONFIGURATION_MISSING",
  "DISCORD_RATE_LIMITED",
  "DISCORD_REJECTED",
  "DISCORD_UNAVAILABLE",
] as const;

export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

const notificationErrorCodeSchema = z.enum(NOTIFICATION_ERROR_CODES);
const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);
const terminalStatusSchema = z.enum(["COMPLETED", "FAILED"]);

const JOB_PROVIDER_COMPATIBILITY_PREDICATE = `
  (
    jobs.active_attempt_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM job_attempts AS attempts
      LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
      WHERE attempts.id = jobs.active_attempt_id
        AND (
          (
            attempts.provider_kind IS NULL
            AND executions.id IS NULL
          )
          OR (
            executions.id = attempts.id
            AND executions.provider_kind = attempts.provider_kind
            AND executions.provider_policy = attempts.provider_policy
            AND executions.status = 'TERMINAL'
            AND executions.create_outcome IS attempts.submission_outcome
            AND executions.provider_handle IS attempts.winning_runpod_job_id
            AND executions.terminal_status IS attempts.runpod_terminal_status
          )
        )
    )
  )
`;

const ENQUEUE_NEXT_TERMINAL_NOTIFICATION_SQL = `
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
    jobs.id,
    jobs.version,
    'PENDING',
    0,
    ?2,
    NULL,
    ?2,
    NULL
  FROM jobs
  WHERE jobs.status IN ('COMPLETED', 'FAILED')
    AND jobs.notified_at IS NULL
    AND jobs.deleted_at IS NULL
    AND (
      (jobs.status = 'COMPLETED' AND jobs.completed_at IS NOT NULL)
      OR (jobs.status = 'FAILED' AND jobs.failed_at IS NOT NULL)
    )
    AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
    AND NOT EXISTS (
      SELECT 1
      FROM notification_outbox AS existing
      WHERE existing.job_id = jobs.id
        AND existing.status IN ('PENDING', 'SENDING')
        AND existing.job_version = jobs.version
    )
  ORDER BY
    CASE jobs.status
      WHEN 'COMPLETED' THEN jobs.completed_at
      ELSE jobs.failed_at
    END,
    jobs.id
  LIMIT 1
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
  RETURNING id
`;

const CLAIM_NOTIFICATION_SQL = `
  UPDATE notification_outbox
  SET
    status = 'SENDING',
    attempt_count = attempt_count + 1,
    next_attempt_at = ?2
  WHERE id = (
    SELECT outbox.id
    FROM notification_outbox AS outbox
    INNER JOIN jobs ON jobs.id = outbox.job_id
    WHERE outbox.status IN ('PENDING', 'SENDING')
      AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= ?1)
      AND jobs.status IN ('COMPLETED', 'FAILED')
      AND outbox.job_version = jobs.version
      AND jobs.notified_at IS NULL
      AND jobs.deleted_at IS NULL
      AND ${JOB_PROVIDER_COMPATIBILITY_PREDICATE}
    ORDER BY COALESCE(outbox.next_attempt_at, outbox.created_at), outbox.id
    LIMIT 1
  )
  RETURNING
    id,
    job_id,
    job_version,
    attempt_count,
    (
      SELECT title
      FROM jobs
      WHERE jobs.id = notification_outbox.job_id
    ) AS title,
    (
      SELECT duration_seconds
      FROM jobs
      WHERE jobs.id = notification_outbox.job_id
    ) AS duration_seconds,
    (
      SELECT attempts.runpod_execution_ms
      FROM jobs
      INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
      WHERE jobs.id = notification_outbox.job_id
    ) AS runpod_execution_ms,
    (
      SELECT status
      FROM jobs
      WHERE jobs.id = notification_outbox.job_id
    ) AS terminal_status
`;

const MARK_NOTIFICATION_SENT_SQL = `
  UPDATE notification_outbox
  SET
    status = 'SENT',
    next_attempt_at = NULL,
    last_error = NULL,
    sent_at = ?3
  WHERE id = ?1
    AND status = 'SENDING'
    AND attempt_count = ?2
  RETURNING id
`;

const MARK_JOB_NOTIFIED_SQL = `
  UPDATE jobs
  SET
    notified_at = ?2,
    updated_at = CASE
      WHEN updated_at > ?2 THEN updated_at
      ELSE ?2
    END
  WHERE id = ?1
    AND status = ?3
    AND version = ?4
    AND notified_at IS NULL
  RETURNING id
`;

const RELEASE_NOTIFICATION_SQL = `
  UPDATE notification_outbox
  SET
    status = ?3,
    next_attempt_at = ?4,
    last_error = ?5
  WHERE id = ?1
    AND status = 'SENDING'
    AND attempt_count = ?2
  RETURNING id
`;

const notificationDeliveryBaseRowSchema = z
  .object({
    attempt_count: z.number().int().positive(),
    id: ulidSchema,
    job_id: ulidSchema,
    job_version: z.number().int().positive(),
    runpod_execution_ms: z.number().int().nonnegative().nullable(),
    title: z.string().min(1).max(MAX_JOB_TITLE_LENGTH),
  })
  .strict();

const notificationDeliveryRowSchema = z.discriminatedUnion("terminal_status", [
  notificationDeliveryBaseRowSchema.extend({
    duration_seconds: z.number().nonnegative().max(28_800),
    terminal_status: z.literal("COMPLETED"),
  }),
  notificationDeliveryBaseRowSchema.extend({
    duration_seconds: z.number().nonnegative().max(28_800).nullable(),
    terminal_status: z.literal("FAILED"),
  }),
]);

interface NotificationDeliveryBase {
  readonly attemptCount: number;
  readonly id: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly runpodExecutionMs: number | null;
  readonly title: string;
}

export type NotificationDelivery =
  | (NotificationDeliveryBase & {
      readonly durationSeconds: number;
      readonly terminalStatus: "COMPLETED";
    })
  | (NotificationDeliveryBase & {
      readonly durationSeconds: number | null;
      readonly terminalStatus: "FAILED";
    });

export interface NotificationOutboxRepository {
  claimNext(timestamp: string, leaseExpiresAt: string): Promise<NotificationDelivery | undefined>;
  enqueueNextTerminal(notificationId: string, timestamp: string): Promise<boolean>;
  markSent(delivery: NotificationDelivery, timestamp: string): Promise<boolean>;
  release(input: {
    readonly delivery: NotificationDelivery;
    readonly errorCode: NotificationErrorCode;
    readonly nextAttemptAt: string | null;
    readonly status: "DEAD" | "PENDING";
  }): Promise<boolean>;
}

export function createD1NotificationOutboxRepository(
  database: D1Database,
): NotificationOutboxRepository {
  return {
    async claimNext(timestamp, leaseExpiresAt) {
      const results = await database
        .prepare(CLAIM_NOTIFICATION_SQL)
        .bind(utcDateTimeSchema.parse(timestamp), utcDateTimeSchema.parse(leaseExpiresAt))
        .all();
      const row = z.array(notificationDeliveryRowSchema).max(1).parse(results.results)[0];
      if (row === undefined) {
        return undefined;
      }
      const deliveryBase = {
        attemptCount: row.attempt_count,
        id: row.id,
        jobId: row.job_id,
        jobVersion: row.job_version,
        runpodExecutionMs: row.runpod_execution_ms,
        title: row.title,
      };
      return row.terminal_status === "COMPLETED"
        ? {
            ...deliveryBase,
            durationSeconds: row.duration_seconds,
            terminalStatus: row.terminal_status,
          }
        : {
            ...deliveryBase,
            durationSeconds: row.duration_seconds,
            terminalStatus: row.terminal_status,
          };
    },

    async enqueueNextTerminal(notificationId, timestamp) {
      const results = await database
        .prepare(ENQUEUE_NEXT_TERMINAL_NOTIFICATION_SQL)
        .bind(ulidSchema.parse(notificationId), utcDateTimeSchema.parse(timestamp))
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },

    async markSent(delivery, timestamp) {
      const parsedTimestamp = utcDateTimeSchema.parse(timestamp);
      const results = await database.batch([
        database
          .prepare(MARK_NOTIFICATION_SENT_SQL)
          .bind(
            ulidSchema.parse(delivery.id),
            z.number().int().positive().parse(delivery.attemptCount),
            parsedTimestamp,
          ),
        database
          .prepare(MARK_JOB_NOTIFIED_SQL)
          .bind(
            ulidSchema.parse(delivery.jobId),
            parsedTimestamp,
            terminalStatusSchema.parse(delivery.terminalStatus),
            z.number().int().positive().parse(delivery.jobVersion),
          ),
      ]);
      const updatedOutbox = updatedIdRowsSchema.parse(results[0]?.results ?? [])[0];
      const updatedJob = updatedIdRowsSchema.parse(results[1]?.results ?? [])[0];
      return updatedOutbox !== undefined && updatedJob !== undefined;
    },

    async release(input) {
      const status = z.enum(["DEAD", "PENDING"]).parse(input.status);
      const nextAttemptAt =
        input.nextAttemptAt === null ? null : utcDateTimeSchema.parse(input.nextAttemptAt);
      if ((status === "PENDING") !== (nextAttemptAt !== null)) {
        throw new Error(
          "Pending notifications require a retry time and dead notifications forbid one",
        );
      }
      const results = await database
        .prepare(RELEASE_NOTIFICATION_SQL)
        .bind(
          ulidSchema.parse(input.delivery.id),
          z.number().int().positive().parse(input.delivery.attemptCount),
          status,
          nextAttemptAt,
          notificationErrorCodeSchema.parse(input.errorCode),
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },
  };
}
