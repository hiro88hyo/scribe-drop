import { z } from "zod";

import {
  OUTPUT_FORMATS,
  MAX_FILE_SIZE_BYTES,
  MAX_RECORDING_DURATION_SECONDS,
  httpsUrlSchema,
  outputFormatSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "./common.js";
import {
  BOUNDED_ARTIFACT_FILENAMES,
  boundedExecutionOptionsSchema,
  boundedResultObjectKeySchema,
} from "./bounded-execution.js";

export const CLOUD_RUN_RUNTIME_POLICY = "cloud_run_jobs_l4_v1" as const;
export const CLOUD_RUN_RUNTIME_ENVIRONMENTS = ["staging", "production"] as const;
export const CLOUD_RUN_RUNTIME_PROGRESS = [
  "bootstrap",
  "download",
  "transcribe",
  "publish",
] as const;
export const CLOUD_RUN_RUNTIME_ERROR_CODES = [
  "BOOTSTRAP_REJECTED",
  "SESSION_REJECTED",
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

export const cloudRunOpaqueHandleSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
export const cloudRunTokenSchema = cloudRunOpaqueHandleSchema;
export const cloudRunPublicKeySchema = cloudRunOpaqueHandleSchema;
export const cloudRunSignatureSchema = z
  .string()
  .length(86)
  .regex(/^[A-Za-z0-9_-]{86}$/u);
export const cloudRunResourceNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*(?:[a-z0-9])$/u);
export const googleIdentityTokenSchema = z
  .string()
  .min(100)
  .max(8_192)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const runtimeIdentitySchema = z
  .object({
    bootstrapRequestId: ulidSchema,
    environment: z.enum(CLOUD_RUN_RUNTIME_ENVIRONMENTS),
    executionHandle: cloudRunOpaqueHandleSchema,
    executionName: cloudRunResourceNameSchema,
    jobName: cloudRunResourceNameSchema,
    policyId: z.literal(CLOUD_RUN_RUNTIME_POLICY),
    publicKey: cloudRunPublicKeySchema,
    taskAttempt: z.literal(0),
    taskCount: z.literal(1),
    taskIndex: z.literal(0),
  })
  .strict();

export const cloudRunBootstrapRequestSchema = runtimeIdentitySchema
  .extend({ identityToken: googleIdentityTokenSchema })
  .strict();

export const cloudRunBootstrapResponseSchema = z
  .object({
    challenge: cloudRunTokenSchema,
    challengeId: ulidSchema,
    expiresAt: utcDateTimeSchema,
  })
  .strict();

export const cloudRunClaimRequestSchema = runtimeIdentitySchema
  .omit({ publicKey: true })
  .extend({
    challengeId: ulidSchema,
    signature: cloudRunSignatureSchema,
  })
  .strict();

const cloudRunSessionSchema = z
  .object({
    expiresAt: utcDateTimeSchema,
    sessionId: ulidSchema,
    token: cloudRunTokenSchema,
  })
  .strict();

const cloudRunSourceCapabilitySchema = z
  .object({
    expectedEtag: z.string().min(1).max(512),
    expectedSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    getUrl: httpsUrlSchema,
  })
  .strict();

export const cloudRunClaimResponseSchema = z
  .object({
    attemptId: ulidSchema,
    jobId: ulidSchema,
    options: boundedExecutionOptionsSchema,
    results: z
      .object({
        artifacts: z
          .array(
            z
              .object({
                format: outputFormatSchema,
                key: boundedResultObjectKeySchema,
                putUrl: httpsUrlSchema,
              })
              .strict(),
          )
          .min(1)
          .max(OUTPUT_FORMATS.length),
        manifestPutUrl: httpsUrlSchema,
      })
      .strict()
      .refine(({ artifacts }) => {
        const formats = artifacts.map(({ format }) => format);
        const canonical = OUTPUT_FORMATS.filter((format) => formats.includes(format));
        return (
          new Set(formats).size === formats.length &&
          formats.every((format, index) => format === canonical[index])
        );
      }, "artifact capabilities must use canonical unique formats"),
    session: cloudRunSessionSchema,
    source: cloudRunSourceCapabilitySchema,
  })
  .strict()
  .refine(
    ({ attemptId, jobId, options, results }) =>
      results.artifacts.length === options.outputFormats.length &&
      results.artifacts.every(
        ({ format, key }, index) =>
          format === options.outputFormats[index] &&
          key.endsWith(`/${jobId}/${attemptId}/${BOUNDED_ARTIFACT_FILENAMES[format]}`),
      ),
    "artifact capabilities must match the exact attempt options",
  );

const authenticatedRuntimeRequestSchema = z
  .object({
    executionHandle: cloudRunOpaqueHandleSchema,
    sequence: z.number().int().nonnegative(),
    sessionId: ulidSchema,
    sessionToken: cloudRunTokenSchema,
  })
  .strict();

export const cloudRunAckRequestSchema = authenticatedRuntimeRequestSchema
  .extend({ state: z.literal("ready") })
  .strict();
export const cloudRunAckResponseSchema = z.object({ acknowledged: z.literal(true) }).strict();

export const cloudRunHeartbeatRequestSchema = authenticatedRuntimeRequestSchema
  .extend({ progress: z.enum(CLOUD_RUN_RUNTIME_PROGRESS) })
  .strict();
export const cloudRunHeartbeatResponseSchema = z.object({ cancelRequested: z.boolean() }).strict();

export const cloudRunTerminalRequestSchema = authenticatedRuntimeRequestSchema
  .extend({
    artifactCount: z.number().int().min(0).max(3),
    durationSeconds: z.number().min(0).max(MAX_RECORDING_DURATION_SECONDS),
    errorCode: z.enum(CLOUD_RUN_RUNTIME_ERROR_CODES).nullable(),
    manifestWritten: z.boolean(),
    segmentCount: z.number().int().nonnegative().max(100_000),
    status: z.enum(["succeeded", "failed", "cancelled"]),
  })
  .strict()
  .refine(
    ({ artifactCount, errorCode, manifestWritten, status }) =>
      status === "succeeded"
        ? artifactCount > 0 && errorCode === null && manifestWritten
        : errorCode !== null && !manifestWritten,
    "terminal fields do not match status",
  );
export const cloudRunTerminalResponseSchema = z
  .object({ accepted: z.literal(true), cleanupPending: z.literal(true) })
  .strict();

export type CloudRunBootstrapRequest = z.infer<typeof cloudRunBootstrapRequestSchema>;
export type CloudRunBootstrapResponse = z.infer<typeof cloudRunBootstrapResponseSchema>;
export type CloudRunClaimRequest = z.infer<typeof cloudRunClaimRequestSchema>;
export type CloudRunClaimResponse = z.infer<typeof cloudRunClaimResponseSchema>;
export type CloudRunAckRequest = z.infer<typeof cloudRunAckRequestSchema>;
export type CloudRunHeartbeatRequest = z.infer<typeof cloudRunHeartbeatRequestSchema>;
export type CloudRunTerminalRequest = z.infer<typeof cloudRunTerminalRequestSchema>;
