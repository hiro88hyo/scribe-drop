import { z } from "zod";

import {
  MAX_FILE_SIZE_BYTES,
  MAX_RECORDING_DURATION_SECONDS,
  SCHEMA_VERSION,
  httpsUrlSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "./common.js";

export const RUNPOD_MIN_EXECUTION_TIMEOUT_MS = 5_000;
export const RUNPOD_MIN_TTL_MS = 10_000;
export const RUNPOD_MAX_POLICY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const RUNPOD_EXECUTION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
export const RUNPOD_JOB_TTL_MS = 8 * 60 * 60 * 1_000;

export const runpodJobIdSchema = z.string().min(1).max(200);
export const runpodCapabilityTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u, "Expected an unpadded 256-bit base64url token");

export const runpodWorkerInputSchema = z
  .object({
    attemptId: ulidSchema,
    claimToken: runpodCapabilityTokenSchema,
    jobId: ulidSchema,
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();

export const runpodRunRequestSchema = z
  .object({
    input: runpodWorkerInputSchema,
    policy: z
      .object({
        executionTimeout: z.literal(RUNPOD_EXECUTION_TIMEOUT_MS),
        ttl: z.literal(RUNPOD_JOB_TTL_MS),
      })
      .strict(),
  })
  .strict();

export const runpodRunResponseSchema = z
  .object({
    id: runpodJobIdSchema,
    status: z.literal("IN_QUEUE"),
  })
  .strict();

export const runpodClaimRequestSchema = z
  .object({
    attemptId: ulidSchema,
    claimToken: runpodCapabilityTokenSchema,
    jobId: ulidSchema,
    runpodJobId: runpodJobIdSchema,
  })
  .strict();

export const runpodClaimResponseSchema = z.union([
  z
    .object({
      expiresAt: utcDateTimeSchema,
      granted: z.literal(true),
      heartbeat: z
        .object({
          token: runpodCapabilityTokenSchema,
          url: httpsUrlSchema,
        })
        .strict(),
      results: z
        .object({
          jsonPutUrl: httpsUrlSchema,
          manifestPutUrl: httpsUrlSchema,
          markdownPutUrl: httpsUrlSchema,
          srtPutUrl: httpsUrlSchema,
        })
        .strict(),
      source: z
        .object({
          expectedEtag: z.string().min(1).max(512),
          expectedSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
          getUrl: httpsUrlSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      deduplicated: z.literal(true),
    })
    .strict(),
]);

export const runpodHeartbeatRequestSchema = z
  .object({
    attemptId: ulidSchema,
    heartbeatToken: runpodCapabilityTokenSchema,
    jobId: ulidSchema,
    runpodJobId: runpodJobIdSchema,
  })
  .strict();

export const runpodHeartbeatResponseSchema = z
  .object({
    cancelRequested: z.boolean(),
  })
  .strict();

export const RUNPOD_STATUSES = [
  "IN_QUEUE",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export const runpodStatusValueSchema = z.enum(RUNPOD_STATUSES);

export const RUNPOD_WORKER_ERROR_CODES = [
  "CLAIM_REJECTED",
  "SOURCE_DOWNLOAD_FAILED",
  "SOURCE_SIZE_MISMATCH",
  "SOURCE_ETAG_MISMATCH",
  "INVALID_MEDIA",
  "DURATION_LIMIT_EXCEEDED",
  "TRANSCRIPTION_FAILED",
  "ARTIFACT_UPLOAD_FAILED",
  "MANIFEST_UPLOAD_FAILED",
  "CANCELLED",
  "INTERNAL_ERROR",
] as const;

export const runpodWorkerErrorCodeSchema = z.enum(RUNPOD_WORKER_ERROR_CODES);

const runpodWorkerOutputIdentitySchema = z.object({
  attemptId: ulidSchema,
  jobId: ulidSchema,
  schemaVersion: z.literal(SCHEMA_VERSION),
});

export const runpodWorkerCompletedOutputSchema = runpodWorkerOutputIdentitySchema
  .extend({
    detectedLanguage: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z0-9-]+$/u),
    durationSeconds: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS),
    manifestWritten: z.literal(true),
    segmentCount: z.number().int().nonnegative(),
    status: z.literal("completed"),
  })
  .strict();

export const runpodWorkerFailedOutputSchema = runpodWorkerOutputIdentitySchema
  .extend({
    errorCode: runpodWorkerErrorCodeSchema,
    manifestWritten: z.literal(false),
    status: z.enum(["cancelled", "failed"]),
  })
  .strict();

export const runpodWorkerDeduplicatedOutputSchema = runpodWorkerOutputIdentitySchema
  .extend({
    manifestWritten: z.literal(false),
    status: z.literal("deduplicated"),
  })
  .strict();

export const runpodWorkerOutputSchema = z.union([
  runpodWorkerCompletedOutputSchema,
  runpodWorkerFailedOutputSchema,
  runpodWorkerDeduplicatedOutputSchema,
]);

export const runpodInternalErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum(["CLAIM_REJECTED", "HEARTBEAT_REJECTED", "INVALID_REQUEST", "INTERNAL_ERROR"]),
        message: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();

const runpodStatusWireResponseSchema = z
  .object({
    delayTime: z.number().int().nonnegative().optional(),
    error: z.string().min(1).max(2_000).optional(),
    executionTime: z.number().int().nonnegative().optional(),
    id: runpodJobIdSchema,
    input: runpodWorkerInputSchema.optional(),
    output: runpodWorkerOutputSchema.optional(),
    status: runpodStatusValueSchema,
    workerId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const runpodStatusResponseSchema = runpodStatusWireResponseSchema.transform(
  ({ error, input, workerId, ...response }) => {
    void error;
    void input;
    void workerId;
    return response;
  },
);

export type RunpodWorkerInput = z.infer<typeof runpodWorkerInputSchema>;
export type RunpodRunRequest = z.infer<typeof runpodRunRequestSchema>;
export type RunpodClaimRequest = z.infer<typeof runpodClaimRequestSchema>;
export type RunpodClaimResponse = z.infer<typeof runpodClaimResponseSchema>;
export type RunpodHeartbeatRequest = z.infer<typeof runpodHeartbeatRequestSchema>;
export type RunpodHeartbeatResponse = z.infer<typeof runpodHeartbeatResponseSchema>;
export type RunpodStatus = z.infer<typeof runpodStatusValueSchema>;
export type RunpodStatusResponse = z.infer<typeof runpodStatusResponseSchema>;
export type RunpodWorkerErrorCode = z.infer<typeof runpodWorkerErrorCodeSchema>;
export type RunpodWorkerOutput = z.infer<typeof runpodWorkerOutputSchema>;
