import { z } from "zod";

import {
  MAX_FILE_SIZE_BYTES,
  SCHEMA_VERSION,
  httpsUrlSchema,
  transcriptionLanguageSchema,
  transcriptionModelSchema,
  ulidSchema,
} from "./common.js";

export const RUNPOD_MIN_EXECUTION_TIMEOUT_MS = 5_000;
export const RUNPOD_MIN_TTL_MS = 10_000;
export const RUNPOD_MAX_POLICY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

const runpodJobIdSchema = z.string().min(1).max(200);
const runpodTokenSchema = z.string().min(32).max(512);

const runpodCallbackSchema = z
  .object({
    token: runpodTokenSchema,
    url: httpsUrlSchema,
  })
  .strict();

export const runpodWorkerInputSchema = z
  .object({
    attempt_id: ulidSchema,
    claim: runpodCallbackSchema,
    heartbeat: runpodCallbackSchema,
    job_id: ulidSchema,
    options: z
      .object({
        beam_size: z.number().int().min(1).max(20),
        language: transcriptionLanguageSchema,
        model: transcriptionModelSchema,
        vad: z.boolean(),
        word_timestamps: z.boolean(),
      })
      .strict(),
    results: z
      .object({
        json_put_url: httpsUrlSchema,
        manifest_put_url: httpsUrlSchema,
        markdown_put_url: httpsUrlSchema,
        srt_put_url: httpsUrlSchema,
      })
      .strict(),
    schema_version: z.literal(SCHEMA_VERSION),
    source: z
      .object({
        expected_etag: z.string().min(1).max(512),
        expected_size_bytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
        url: httpsUrlSchema,
      })
      .strict(),
  })
  .strict();

export const runpodRunRequestSchema = z
  .object({
    input: runpodWorkerInputSchema,
    policy: z
      .object({
        executionTimeout: z
          .number()
          .int()
          .min(RUNPOD_MIN_EXECUTION_TIMEOUT_MS)
          .max(RUNPOD_MAX_POLICY_DURATION_MS),
        lowPriority: z.boolean(),
        ttl: z.number().int().min(RUNPOD_MIN_TTL_MS).max(RUNPOD_MAX_POLICY_DURATION_MS),
      })
      .strict(),
    webhook: httpsUrlSchema,
  })
  .strict()
  .refine(
    ({ policy }) => policy.executionTimeout <= policy.ttl,
    "RunPod execution timeout must not exceed job TTL",
  );

export const runpodRunResponseSchema = z
  .object({
    id: runpodJobIdSchema,
    status: z.literal("IN_QUEUE"),
  })
  .strict();

export const runpodClaimRequestSchema = z
  .object({
    attemptId: ulidSchema,
    jobId: ulidSchema,
    runpodJobId: runpodJobIdSchema,
    token: runpodTokenSchema,
  })
  .strict();

export const runpodClaimResponseSchema = z.union([
  z
    .object({
      cancelRequested: z.boolean(),
      granted: z.literal(true),
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
    jobId: ulidSchema,
    runpodJobId: runpodJobIdSchema,
    token: runpodTokenSchema,
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

export const runpodWorkerOutputSchema = z
  .object({
    attemptId: ulidSchema,
    complete: z.literal(true),
    jobId: ulidSchema,
    manifestKey: z.string().min(1).max(1024).startsWith("results/"),
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();

export const runpodStatusResponseSchema = z
  .object({
    delayTime: z.number().int().nonnegative().optional(),
    error: z.string().min(1).max(2_000).optional(),
    executionTime: z.number().int().nonnegative().optional(),
    id: runpodJobIdSchema,
    output: runpodWorkerOutputSchema.optional(),
    status: runpodStatusValueSchema,
    workerId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const runpodWebhookPayloadSchema = runpodStatusResponseSchema;

export type RunpodWorkerInput = z.infer<typeof runpodWorkerInputSchema>;
export type RunpodRunRequest = z.infer<typeof runpodRunRequestSchema>;
export type RunpodClaimRequest = z.infer<typeof runpodClaimRequestSchema>;
export type RunpodClaimResponse = z.infer<typeof runpodClaimResponseSchema>;
export type RunpodHeartbeatRequest = z.infer<typeof runpodHeartbeatRequestSchema>;
export type RunpodHeartbeatResponse = z.infer<typeof runpodHeartbeatResponseSchema>;
export type RunpodStatus = z.infer<typeof runpodStatusValueSchema>;
export type RunpodStatusResponse = z.infer<typeof runpodStatusResponseSchema>;
