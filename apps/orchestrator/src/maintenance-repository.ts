import { ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const maintenanceLimitSchema = z.number().int().min(1).max(100);
const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);

const FIND_EXPIRED_UPLOADS_SQL = `
  SELECT id, upload_expires_at
  FROM jobs
  WHERE status IN ('CREATED', 'UPLOADING')
    AND upload_expires_at IS NOT NULL
    AND upload_expires_at <= ?1
    AND deleted_at IS NULL
  ORDER BY upload_expires_at, id
  LIMIT ?2
`;

const EXPIRE_UPLOAD_SQL = `
  UPDATE jobs
  SET
    status = 'EXPIRED',
    error_code = 'UPLOAD_EXPIRED',
    error_message = NULL,
    updated_at = ?2,
    version = version + 1
  WHERE id = ?1
    AND status IN ('CREATED', 'UPLOADING')
    AND upload_expires_at IS NOT NULL
    AND upload_expires_at <= ?2
    AND deleted_at IS NULL
  RETURNING id
`;

const RECORD_UPLOAD_EXPIRY_SQL = `
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
    'upload_expired',
    'orchestrator',
    NULL,
    ?3
  FROM jobs
  WHERE id = ?2
    AND status = 'EXPIRED'
    AND updated_at = ?3
  ON CONFLICT(id) DO NOTHING
`;

const expiredUploadRowSchema = z
  .object({
    id: ulidSchema,
    upload_expires_at: utcDateTimeSchema,
  })
  .strict();

export interface ExpiredUpload {
  readonly jobId: string;
  readonly uploadExpiresAt: string;
}

export interface MaintenanceRepository {
  expireUpload(input: {
    readonly eventId: string;
    readonly jobId: string;
    readonly timestamp: string;
  }): Promise<boolean>;
  findExpiredUploads(timestamp: string, limit: number): Promise<readonly ExpiredUpload[]>;
}

export function createD1MaintenanceRepository(database: D1Database): MaintenanceRepository {
  return {
    async expireUpload(input) {
      const timestamp = utcDateTimeSchema.parse(input.timestamp);
      const results = await database.batch([
        database.prepare(EXPIRE_UPLOAD_SQL).bind(ulidSchema.parse(input.jobId), timestamp),
        database
          .prepare(RECORD_UPLOAD_EXPIRY_SQL)
          .bind(ulidSchema.parse(input.eventId), input.jobId, timestamp),
      ]);
      return updatedIdRowsSchema.parse(results[0]?.results ?? [])[0] !== undefined;
    },

    async findExpiredUploads(timestamp, limit) {
      const parsedLimit = maintenanceLimitSchema.parse(limit);
      const results = await database
        .withSession("first-primary")
        .prepare(FIND_EXPIRED_UPLOADS_SQL)
        .bind(utcDateTimeSchema.parse(timestamp), parsedLimit)
        .all();
      return z
        .array(expiredUploadRowSchema)
        .max(parsedLimit)
        .parse(results.results)
        .map((row) => ({
          jobId: row.id,
          uploadExpiresAt: row.upload_expires_at,
        }));
    },
  };
}
