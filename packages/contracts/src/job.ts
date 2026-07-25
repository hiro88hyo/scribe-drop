import { z } from "zod";

import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  MAX_ORIGINAL_FILENAME_LENGTH,
  MAX_RECORDING_DURATION_SECONDS,
  allowedMediaTypeSchema,
  httpsUrlSchema,
  jobStatusSchema,
  outputFormatSchema,
  publicErrorCodeSchema,
  transcriptionLanguageSchema,
  transcriptionModelSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "./common.js";

const outputFormatsSchema = z
  .array(outputFormatSchema)
  .min(1)
  .max(3)
  .refine(
    (formats) => new Set(formats).size === formats.length,
    "Output formats must not contain duplicates",
  );

export const jobOptionsSchema = z
  .object({
    language: transcriptionLanguageSchema,
    model: transcriptionModelSchema,
    outputFormats: outputFormatsSchema,
    vad: z.boolean(),
  })
  .strict();

export const createJobRequestSchema = z
  .object({
    contentType: allowedMediaTypeSchema,
    filename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_LENGTH),
    options: jobOptionsSchema,
    sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    title: z
      .string()
      .min(1)
      .max(MAX_JOB_TITLE_LENGTH)
      .refine((value) => value.trim().length > 0, "Title must contain a visible character"),
  })
  .strict();

export const temporaryUploadCredentialsSchema = z
  .object({
    accessKeyId: z.string().min(1).max(256),
    bucket: z.string().min(3).max(63),
    endpoint: httpsUrlSchema,
    expiresAt: utcDateTimeSchema,
    key: z.string().min(1).max(1024).startsWith("incoming/"),
    region: z.literal("auto"),
    secretAccessKey: z.string().min(1).max(256),
    sessionToken: z.string().min(1).max(4096),
  })
  .strict();

export const createJobResponseSchema = z
  .object({
    jobId: ulidSchema,
    upload: temporaryUploadCredentialsSchema,
  })
  .strict();

export const uploadCompleteRequestSchema = z.object({}).strict();

export const artifactSummarySchema = z
  .object({
    format: outputFormatSchema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const jobSummarySchema = z
  .object({
    actualSizeBytes: z.number().int().nonnegative().nullable(),
    completedAt: utcDateTimeSchema.nullable(),
    createdAt: utcDateTimeSchema,
    durationSeconds: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS).nullable(),
    errorCode: publicErrorCodeSchema.nullable(),
    expectedSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    id: ulidSchema,
    originalFilename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_LENGTH),
    sourceContentType: allowedMediaTypeSchema,
    status: jobStatusSchema,
    title: z.string().min(1).max(MAX_JOB_TITLE_LENGTH),
    updatedAt: utcDateTimeSchema,
  })
  .strict();

export const jobDetailSchema = jobSummarySchema
  .extend({
    artifacts: z.array(artifactSummarySchema).max(3),
    options: jobOptionsSchema,
  })
  .strict();

export const listJobsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export const listJobsResponseSchema = z
  .object({
    items: z.array(jobSummarySchema),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict();

export const artifactDownloadResponseSchema = z
  .object({
    expiresAt: utcDateTimeSchema,
    url: httpsUrlSchema,
  })
  .strict();

export const jobActionResponseSchema = z
  .object({
    job: jobSummarySchema,
  })
  .strict();

export const meResponseSchema = z
  .object({
    csrfToken: z.string().min(32).max(4096),
    user: z
      .object({
        email: z.email().max(320),
        sub: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: publicErrorCodeSchema,
        message: z.string().min(1).max(500),
        requestId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export type JobOptions = z.infer<typeof jobOptionsSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
export type ListJobsResponse = z.infer<typeof listJobsResponseSchema>;
export type JobActionResponse = z.infer<typeof jobActionResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
