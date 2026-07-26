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
      AND jobs.status = 'COMPLETED'
      AND jobs.deleted_at IS NULL
    ORDER BY COALESCE(outbox.next_attempt_at, outbox.created_at), outbox.id
    LIMIT 1
  )
  RETURNING
    id,
    job_id,
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
    ) AS runpod_execution_ms
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
    AND status = 'COMPLETED'
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

const notificationDeliveryRowSchema = z
  .object({
    attempt_count: z.number().int().positive(),
    duration_seconds: z.number().nonnegative().max(28_800),
    id: ulidSchema,
    job_id: ulidSchema,
    runpod_execution_ms: z.number().int().nonnegative().nullable(),
    title: z.string().min(1).max(MAX_JOB_TITLE_LENGTH),
  })
  .strict();

export interface NotificationDelivery {
  readonly attemptCount: number;
  readonly durationSeconds: number;
  readonly id: string;
  readonly jobId: string;
  readonly runpodExecutionMs: number | null;
  readonly title: string;
}

export interface NotificationOutboxRepository {
  claimNext(timestamp: string, leaseExpiresAt: string): Promise<NotificationDelivery | undefined>;
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
      return row === undefined
        ? undefined
        : {
            attemptCount: row.attempt_count,
            durationSeconds: row.duration_seconds,
            id: row.id,
            jobId: row.job_id,
            runpodExecutionMs: row.runpod_execution_ms,
            title: row.title,
          };
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
          .bind(ulidSchema.parse(delivery.jobId), parsedTimestamp),
      ]);
      return updatedIdRowsSchema.parse(results[0]?.results ?? [])[0] !== undefined;
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
