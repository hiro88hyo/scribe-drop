import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_JOB_TITLE_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;
export const MAX_RECORDING_DURATION_SECONDS = 8 * 60 * 60;

export const OUTPUT_FORMATS = ["markdown", "json", "srt"] as const;
export const TRANSCRIPTION_LANGUAGES = ["ja", "auto"] as const;
export const TRANSCRIPTION_MODELS = ["large-v3-turbo"] as const;
export const ALLOWED_MEDIA_TYPES = [
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export const JOB_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "SUBMISSION_PENDING",
  "SUBMITTING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "SOURCE_MUTATED",
] as const;

export const ATTEMPT_STATUSES = [
  "SUBMISSION_PENDING",
  "SUBMITTING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const PUBLIC_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UNSUPPORTED_MEDIA_TYPE",
  "FILE_TOO_LARGE",
  "TOO_MANY_ACTIVE_JOBS",
  "UPLOAD_EXPIRED",
  "SOURCE_NOT_FOUND",
  "SOURCE_SIZE_MISMATCH",
  "SOURCE_ETAG_CHANGED",
  "INVALID_STATE",
  "PROCESSING_FAILED",
  "ARTIFACT_NOT_READY",
  "INTERNAL_ERROR",
] as const;

export const outputFormatSchema = z.enum(OUTPUT_FORMATS);
export const transcriptionLanguageSchema = z.enum(TRANSCRIPTION_LANGUAGES);
export const transcriptionModelSchema = z.enum(TRANSCRIPTION_MODELS);
export const allowedMediaTypeSchema = z.enum(ALLOWED_MEDIA_TYPES);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export const publicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);

export const ulidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, "Expected an uppercase Crockford Base32 ULID");

export const utcDateTimeSchema = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "Expected a UTC timestamp ending in Z");

export const httpsUrlSchema = z
  .url()
  .refine((value) => value.startsWith("https://"), "Expected an HTTPS URL");

export type OutputFormat = z.infer<typeof outputFormatSchema>;
export type TranscriptionLanguage = z.infer<typeof transcriptionLanguageSchema>;
export type TranscriptionModel = z.infer<typeof transcriptionModelSchema>;
export type AllowedMediaType = z.infer<typeof allowedMediaTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
