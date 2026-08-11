import { z } from "zod";

import { ulidSchema, utcDateTimeSchema } from "./common.js";
import {
  CLOUD_RUN_RUNTIME_ENVIRONMENTS,
  CLOUD_RUN_RUNTIME_POLICY,
  cloudRunOpaqueHandleSchema,
  cloudRunResourceNameSchema,
} from "./cloud-run-runtime.js";

export const CLOUD_RUN_CONTROLLER_ATTEST_PATH = "/v1/executions/attest" as const;
export const CLOUD_RUN_CONTROLLER_MUTATION_PATH = "/v1/executions" as const;
export const CLOUD_RUN_CONTROLLER_KEY_IDS = ["primary", "secondary"] as const;
export const CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS = 60_000;
export const CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS = 30_000;

const runtimeServiceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u);

export const CLOUD_RUN_CONTROLLER_ACTIONS = [
  "create",
  "observe",
  "reconcile",
  "cancel",
  "cleanup",
] as const;
export const CLOUD_RUN_CONTROLLER_OUTCOMES = [
  "accepted",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cleaned",
  "unknown",
  "rejected",
] as const;
export const CLOUD_RUN_CONTROLLER_ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "BUDGET_EXHAUSTED",
  "CONFLICT",
  "ENVIRONMENT_MISMATCH",
  "EXPIRED_REQUEST",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "MULTIPLE_EXECUTIONS",
  "PROVIDER_PERMANENT",
  "PROVIDER_RETRYABLE",
  "RATE_LIMITED",
  "RESOURCE_DRIFT",
  "STALE_VERSION",
  "UNKNOWN_OUTCOME",
] as const;

export const cloudRunControllerRequestSchema = z
  .object({
    action: z.enum(CLOUD_RUN_CONTROLLER_ACTIONS),
    environment: z.enum(CLOUD_RUN_RUNTIME_ENVIRONMENTS),
    executionHandle: cloudRunOpaqueHandleSchema,
    expectedVersion: z.number().int().nonnegative(),
    expiresAt: utcDateTimeSchema,
    issuedAt: utcDateTimeSchema,
    policyId: z.literal(CLOUD_RUN_RUNTIME_POLICY),
    requestId: ulidSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export const cloudRunControllerResponseSchema = z
  .object({
    errorCode: z.enum(CLOUD_RUN_CONTROLLER_ERROR_CODES).nullable(),
    executionHandle: cloudRunOpaqueHandleSchema,
    outcome: z.enum(CLOUD_RUN_CONTROLLER_OUTCOMES),
    requestId: ulidSchema,
    schemaVersion: z.literal(1),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const cloudRunControllerAttestationRequestSchema = z
  .object({
    environment: z.enum(CLOUD_RUN_RUNTIME_ENVIRONMENTS),
    executionHandle: cloudRunOpaqueHandleSchema,
    expiresAt: utcDateTimeSchema,
    issuedAt: utcDateTimeSchema,
    policyId: z.literal(CLOUD_RUN_RUNTIME_POLICY),
    requestId: ulidSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

const liveAttestationSchema = z
  .object({
    activeExecutionCount: z.literal(1),
    controllerVersion: z.number().int().positive(),
    environment: z.enum(CLOUD_RUN_RUNTIME_ENVIRONMENTS),
    executionHandle: cloudRunOpaqueHandleSchema,
    executionName: cloudRunResourceNameSchema,
    jobName: cloudRunResourceNameSchema,
    manifestMatches: z.boolean(),
    policyId: z.literal(CLOUD_RUN_RUNTIME_POLICY),
    retriedCount: z.number().int().nonnegative().max(1),
    runtimeServiceAccount: runtimeServiceAccountSchema,
    state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    taskCount: z.literal(1),
  })
  .strict();

export const CLOUD_RUN_CONTROLLER_ATTESTATION_OUTCOMES = [
  "found",
  "not_found",
  "unavailable",
  "invariant_failure",
] as const;

export const cloudRunControllerAttestationResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      attestation: liveAttestationSchema,
      executionHandle: cloudRunOpaqueHandleSchema,
      outcome: z.literal("found"),
      requestId: ulidSchema,
      schemaVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      attestation: z.null(),
      executionHandle: cloudRunOpaqueHandleSchema,
      outcome: z.enum(["not_found", "unavailable", "invariant_failure"]),
      requestId: ulidSchema,
      schemaVersion: z.literal(1),
    })
    .strict(),
]);

export const cloudRunControllerHeadersSchema = z
  .object({
    keyId: z.enum(CLOUD_RUN_CONTROLLER_KEY_IDS),
    signature: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export type CloudRunControllerAttestationRequest = z.infer<
  typeof cloudRunControllerAttestationRequestSchema
>;
export type CloudRunControllerAttestationResponse = z.infer<
  typeof cloudRunControllerAttestationResponseSchema
>;
export type CloudRunControllerLiveAttestation = z.infer<typeof liveAttestationSchema>;
export type CloudRunControllerKeyId = (typeof CLOUD_RUN_CONTROLLER_KEY_IDS)[number];
export type CloudRunControllerRequest = z.infer<typeof cloudRunControllerRequestSchema>;
export type CloudRunControllerResponse = z.infer<typeof cloudRunControllerResponseSchema>;
export type CloudRunControllerAction = CloudRunControllerRequest["action"];
export type CloudRunControllerOutcome = CloudRunControllerResponse["outcome"];
export type CloudRunControllerErrorCode = NonNullable<CloudRunControllerResponse["errorCode"]>;

export interface CloudRunControllerSignedRequest {
  readonly [key: string]: unknown;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly requestId: string;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeCloudRunControllerRequest(request: unknown): string {
  return canonicalize(request);
}

function frameAsciiPart(value: string): string {
  if (!/^[\x20-\x7E]*$/u.test(value)) {
    throw new Error("Cloud Run controller signing frame must be ASCII");
  }
  return `${String(value.length)}:${value}`;
}

export function buildCloudRunControllerSigningFrame(input: {
  readonly method: string;
  readonly path: string;
  readonly request: CloudRunControllerSignedRequest;
  readonly requestDigest: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.request.issuedAt,
    input.request.expiresAt,
    input.request.requestId,
    input.requestDigest,
  ]
    .map(frameAsciiPart)
    .join("|");
}
