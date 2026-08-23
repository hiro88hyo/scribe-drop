import {
  boundedExecutionOptionsSchema,
  runpodExecutionOptionsSchema,
  ulidSchema,
  utcDateTimeSchema,
  type BoundedExecutionOptions,
  type RunpodExecutionOptions,
} from "@scribe-drop/contracts";
import type { GpuCleanupStatus, GpuExecutionStatus } from "@scribe-drop/domain";
import { z } from "zod";

const FIND_EXECUTION_COMPATIBILITY_SQL = `
  SELECT
    attempts.id AS attempt_id,
    attempts.status AS attempt_status,
    attempts.provider_kind AS attempt_provider_kind,
    attempts.provider_policy AS attempt_provider_policy,
    attempts.execution_contract_version,
    attempts.execution_options_json,
    attempts.submission_outcome,
    attempts.winning_runpod_job_id,
    attempts.runpod_terminal_status,
    executions.id AS execution_id,
    executions.provider_kind AS execution_provider_kind,
    executions.provider_policy AS execution_provider_policy,
    executions.status AS execution_status,
    executions.create_outcome,
    executions.provider_handle,
    executions.terminal_status,
    executions.cleanup_status,
    executions.version,
    executions.created_at,
    executions.updated_at
  FROM job_attempts AS attempts
  LEFT JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
  WHERE attempts.id = ?1
  LIMIT 1
`;

const TERMINAL_COMPATIBILITY_PREDICATE = `
  EXISTS (
    SELECT 1
    FROM job_attempts AS attempts
    WHERE attempts.id = provider_executions.attempt_id
      AND attempts.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
      AND attempts.provider_kind = provider_executions.provider_kind
      AND attempts.provider_policy = provider_executions.provider_policy
      AND attempts.submission_outcome IS provider_executions.create_outcome
      AND attempts.winning_runpod_job_id IS provider_executions.provider_handle
      AND attempts.runpod_terminal_status IS provider_executions.terminal_status
  )
`;

const REQUEST_CLEANUP_SQL = `
  UPDATE provider_executions
  SET
    cleanup_status = 'PENDING',
    version = version + 1,
    updated_at = ?3
  WHERE attempt_id = ?1
    AND version = ?2
    AND status = 'TERMINAL'
    AND cleanup_status IN ('NOT_REQUESTED', 'FAILED')
    AND ${TERMINAL_COMPATIBILITY_PREDICATE}
  RETURNING id
`;

const CLAIM_CLEANUP_SQL = `
  UPDATE provider_executions
  SET
    cleanup_status = 'IN_PROGRESS',
    version = version + 1,
    updated_at = ?3
  WHERE attempt_id = ?1
    AND version = ?2
    AND status = 'TERMINAL'
    AND cleanup_status = 'PENDING'
    AND ${TERMINAL_COMPATIBILITY_PREDICATE}
  RETURNING id
`;

const COMPLETE_CLEANUP_SQL = `
  UPDATE provider_executions
  SET
    cleanup_status = ?3,
    version = version + 1,
    updated_at = ?4
  WHERE attempt_id = ?1
    AND version = ?2
    AND status = 'TERMINAL'
    AND cleanup_status = 'IN_PROGRESS'
    AND ${TERMINAL_COMPATIBILITY_PREDICATE}
  RETURNING id
`;

const updatedIdRowsSchema = z.array(z.object({ id: ulidSchema }).strict()).max(1);

const compatibilityRowSchema = z
  .object({
    attempt_id: ulidSchema,
    attempt_provider_kind: z.literal("runpod_serverless").nullable(),
    attempt_provider_policy: z.literal("runpod_serverless_v1").nullable(),
    attempt_status: z.enum([
      "SUBMISSION_PENDING",
      "SUBMITTING",
      "RUNNING",
      "CANCEL_REQUESTED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]),
    cleanup_status: z
      .enum(["NOT_REQUESTED", "PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED"])
      .nullable(),
    create_outcome: z.enum(["accepted", "rejected", "unknown"]).nullable(),
    created_at: utcDateTimeSchema.nullable(),
    execution_contract_version: z.union([z.literal(1), z.literal(2)]).nullable(),
    execution_id: ulidSchema.nullable(),
    execution_options_json: z.string().nullable(),
    execution_provider_kind: z.literal("runpod_serverless").nullable(),
    execution_provider_policy: z.literal("runpod_serverless_v1").nullable(),
    execution_status: z
      .enum(["PENDING", "CREATING", "RUNNING", "CANCEL_REQUESTED", "TERMINAL"])
      .nullable(),
    provider_handle: z.string().min(1).max(256).nullable(),
    runpod_terminal_status: z.enum(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]).nullable(),
    submission_outcome: z.enum(["accepted", "rejected", "unknown"]).nullable(),
    terminal_status: z.enum(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]).nullable(),
    updated_at: utcDateTimeSchema.nullable(),
    version: z.number().int().positive().nullable(),
    winning_runpod_job_id: z.string().min(1).max(256).nullable(),
  })
  .strict();

type ExecutionOptions = BoundedExecutionOptions | RunpodExecutionOptions;

export interface ProviderExecutionCompatibility {
  readonly attemptId: string;
  readonly cleanupStatus: GpuCleanupStatus;
  readonly contractVersion: 1 | 2;
  readonly executionId: string;
  readonly options: ExecutionOptions;
  readonly providerHandle: string | null;
  readonly status: GpuExecutionStatus;
  readonly version: number;
}

export interface ProviderExecutionRepository {
  claimCleanup(input: ProviderCleanupMutation): Promise<boolean>;
  completeCleanup(
    input: ProviderCleanupMutation & { readonly outcome: "FAILED" | "SUCCEEDED" },
  ): Promise<boolean>;
  findCompatibleExecution(attemptId: string): Promise<ProviderExecutionCompatibility | undefined>;
  requestCleanup(input: ProviderCleanupMutation): Promise<boolean>;
}

export interface ProviderCleanupMutation {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
}

function expectedExecutionStatus(
  attemptStatus: z.infer<typeof compatibilityRowSchema>["attempt_status"],
): GpuExecutionStatus {
  switch (attemptStatus) {
    case "SUBMISSION_PENDING":
      return "PENDING";
    case "SUBMITTING":
      return "CREATING";
    case "RUNNING":
      return "RUNNING";
    case "CANCEL_REQUESTED":
      return "CANCEL_REQUESTED";
    case "CANCELLED":
    case "COMPLETED":
    case "FAILED":
      return "TERMINAL";
  }
}

function parseOptions(version: 1 | 2, serialized: string): ExecutionOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Provider execution compatibility check failed");
  }
  return version === 1
    ? runpodExecutionOptionsSchema.parse(parsed)
    : boundedExecutionOptionsSchema.parse(parsed);
}

function mapCompatibleExecution(untrusted: unknown): ProviderExecutionCompatibility {
  const row = compatibilityRowSchema.parse(untrusted);
  if (
    row.attempt_provider_kind === null ||
    row.attempt_provider_policy === null ||
    row.execution_contract_version === null ||
    row.execution_options_json === null ||
    row.execution_id !== row.attempt_id ||
    row.execution_provider_kind !== row.attempt_provider_kind ||
    row.execution_provider_policy !== row.attempt_provider_policy ||
    row.execution_status !== expectedExecutionStatus(row.attempt_status) ||
    row.create_outcome !== row.submission_outcome ||
    row.provider_handle !== row.winning_runpod_job_id ||
    row.terminal_status !== row.runpod_terminal_status ||
    row.cleanup_status === null ||
    row.version === null ||
    row.created_at === null ||
    row.updated_at === null
  ) {
    throw new Error("Provider execution compatibility check failed");
  }
  return {
    attemptId: row.attempt_id,
    cleanupStatus: row.cleanup_status,
    contractVersion: row.execution_contract_version,
    executionId: row.execution_id,
    options: parseOptions(row.execution_contract_version, row.execution_options_json),
    providerHandle: row.provider_handle,
    status: row.execution_status,
    version: row.version,
  };
}

export function createD1ProviderExecutionRepository(
  database: D1Database,
): ProviderExecutionRepository {
  return {
    async claimCleanup(input) {
      const results = await database
        .prepare(CLAIM_CLEANUP_SQL)
        .bind(
          ulidSchema.parse(input.attemptId),
          z.number().int().positive().parse(input.expectedVersion),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },

    async completeCleanup(input) {
      const results = await database
        .prepare(COMPLETE_CLEANUP_SQL)
        .bind(
          ulidSchema.parse(input.attemptId),
          z.number().int().positive().parse(input.expectedVersion),
          z.enum(["FAILED", "SUCCEEDED"]).parse(input.outcome),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },

    async findCompatibleExecution(attemptId) {
      const parsedAttemptId = ulidSchema.parse(attemptId);
      const untrusted = await database
        .withSession("first-primary")
        .prepare(FIND_EXECUTION_COMPATIBILITY_SQL)
        .bind(parsedAttemptId)
        .first();
      return untrusted === null ? undefined : mapCompatibleExecution(untrusted);
    },

    async requestCleanup(input) {
      const results = await database
        .prepare(REQUEST_CLEANUP_SQL)
        .bind(
          ulidSchema.parse(input.attemptId),
          z.number().int().positive().parse(input.expectedVersion),
          utcDateTimeSchema.parse(input.timestamp),
        )
        .all();
      return updatedIdRowsSchema.parse(results.results)[0] !== undefined;
    },
  };
}
