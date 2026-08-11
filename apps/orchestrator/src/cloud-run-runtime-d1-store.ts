import {
  boundedExecutionOptionsSchema,
  cloudRunOpaqueHandleSchema,
  cloudRunPublicKeySchema,
  cloudRunResourceNameSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "@scribe-drop/contracts";
import { z } from "zod";

import { parseSourceObjectKey } from "./source-object-key.js";
import type {
  ApplySessionEventResult,
  BeginBootstrapResult,
  CloudRunRuntimeStore,
  ConsumeChallengeResult,
  RuntimeAttemptContext,
  RuntimeBootstrapRecord,
  RuntimeSessionEvent,
} from "./cloud-run-runtime-store.js";

const runtimeDigestSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
const runtimeEnvironmentSchema = z.enum(["staging", "production"]);

const bootstrapRowSchema = z
  .object({
    bootstrap_request_id: ulidSchema,
    challenge_expires_at: utcDateTimeSchema,
    challenge_hash: runtimeDigestSchema,
    challenge_id: ulidSchema,
    claim_digest: runtimeDigestSchema.nullable(),
    execution_handle: cloudRunOpaqueHandleSchema,
    execution_name: cloudRunResourceNameSchema,
    job_name: cloudRunResourceNameSchema,
    last_sequence: z.number().int().min(-1),
    public_key: cloudRunPublicKeySchema,
    public_key_digest: runtimeDigestSchema,
    request_digest: runtimeDigestSchema,
    revoked_at: utcDateTimeSchema.nullable(),
    session_expires_at: utcDateTimeSchema.nullable(),
    session_id: ulidSchema.nullable(),
    session_issued_at: utcDateTimeSchema.nullable(),
    session_token_hash: runtimeDigestSchema.nullable(),
    terminal_digest: runtimeDigestSchema.nullable(),
  })
  .strict();

const attemptRowSchema = z
  .object({
    active_attempt_id: ulidSchema,
    attempt_id: ulidSchema,
    attempt_provider_kind: z.literal("cloud_run_jobs"),
    attempt_provider_policy: z.literal("cloud_run_jobs_l4_v1"),
    attempt_status: z.enum(["RUNNING", "CANCEL_REQUESTED"]),
    claim_digest: runtimeDigestSchema.nullable(),
    execution_contract_version: z.literal(2),
    execution_handle: cloudRunOpaqueHandleSchema,
    execution_options_json: z.string(),
    execution_provider_kind: z.literal("cloud_run_jobs"),
    execution_provider_policy: z.literal("cloud_run_jobs_l4_v1"),
    execution_status: z.enum(["RUNNING", "CANCEL_REQUESTED"]),
    expected_size_bytes: z.number().int().positive(),
    job_id: ulidSchema,
    job_status: z.enum(["RUNNING", "CANCEL_REQUESTED"]),
    result_prefix: z.string().min(1).max(900).startsWith("results/").endsWith("/"),
    revoked_at: utcDateTimeSchema.nullable(),
    session_id: ulidSchema.nullable(),
    source_etag: z.string().min(1).max(512),
    source_key: z.string().min(1).max(1024),
    source_size_bytes: z.number().int().positive(),
  })
  .strict();

const eventReplayRowSchema = z
  .object({
    kind: z.enum(["ack", "heartbeat", "terminal"]),
    request_digest: runtimeDigestSchema,
  })
  .strict();

const returnedBootstrapRowsSchema = z
  .array(z.object({ bootstrap_request_id: ulidSchema }).strict())
  .max(1);

const BOOTSTRAP_COLUMNS = `
  bootstrap_request_id,
  request_digest,
  execution_handle,
  execution_name,
  job_name,
  public_key,
  public_key_digest,
  challenge_id,
  challenge_hash,
  challenge_expires_at,
  session_id,
  session_token_hash,
  session_issued_at,
  session_expires_at,
  claim_digest,
  last_sequence,
  revoked_at,
  terminal_digest
`;

const FIND_ATTEMPT_SQL = `
  SELECT
    jobs.active_attempt_id,
    attempts.id AS attempt_id,
    attempts.provider_kind AS attempt_provider_kind,
    attempts.provider_policy AS attempt_provider_policy,
    attempts.status AS attempt_status,
    attempts.execution_contract_version,
    attempts.execution_options_json,
    attempts.result_prefix,
    executions.provider_kind AS execution_provider_kind,
    executions.provider_policy AS execution_provider_policy,
    executions.provider_handle AS execution_handle,
    executions.status AS execution_status,
    jobs.id AS job_id,
    jobs.status AS job_status,
    jobs.source_etag,
    jobs.source_key,
    jobs.actual_size_bytes AS source_size_bytes,
    jobs.expected_size_bytes,
    bootstraps.session_id,
    bootstraps.claim_digest,
    bootstraps.revoked_at
  FROM provider_executions AS executions
  INNER JOIN job_attempts AS attempts ON attempts.id = executions.attempt_id
  INNER JOIN jobs ON jobs.id = attempts.job_id
  LEFT JOIN cloud_run_runtime_bootstraps AS bootstraps
    ON bootstraps.execution_id = executions.id
  WHERE executions.provider_kind = 'cloud_run_jobs'
    AND executions.provider_policy = 'cloud_run_jobs_l4_v1'
    AND executions.provider_handle = ?1
    AND executions.status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND attempts.status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND jobs.status IN ('RUNNING', 'CANCEL_REQUESTED')
    AND jobs.active_attempt_id = attempts.id
    AND attempts.provider_kind = executions.provider_kind
    AND attempts.provider_policy = executions.provider_policy
    AND attempts.execution_contract_version = 2
    AND jobs.source_etag IS NOT NULL
    AND jobs.actual_size_bytes IS NOT NULL
    AND jobs.actual_size_bytes = jobs.expected_size_bytes
`;

const INSERT_BOOTSTRAP_SQL = `
  INSERT INTO cloud_run_runtime_bootstraps (
    bootstrap_request_id,
    execution_id,
    request_digest,
    execution_handle,
    execution_name,
    job_name,
    public_key,
    public_key_digest,
    challenge_id,
    challenge_hash,
    challenge_expires_at,
    session_id,
    session_token_hash,
    session_issued_at,
    session_expires_at,
    claim_digest,
    last_sequence,
    revoked_at,
    terminal_digest,
    created_at,
    updated_at
  )
  SELECT
    ?1,
    executions.id,
    ?2,
    ?3,
    ?4,
    ?5,
    ?6,
    ?7,
    ?8,
    ?9,
    ?10,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    -1,
    NULL,
    NULL,
    ?11,
    ?11
  FROM provider_executions AS executions
  INNER JOIN job_attempts AS attempts ON attempts.id = executions.attempt_id
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE executions.provider_kind = 'cloud_run_jobs'
    AND executions.provider_policy = 'cloud_run_jobs_l4_v1'
    AND executions.provider_handle = ?3
    AND executions.status = 'RUNNING'
    AND attempts.id = ?12
    AND attempts.job_id = ?13
    AND attempts.status = 'RUNNING'
    AND jobs.status = 'RUNNING'
    AND jobs.active_attempt_id = attempts.id
    AND NOT EXISTS (
      SELECT 1
      FROM cloud_run_runtime_bootstraps AS existing
      WHERE existing.execution_id = executions.id
    )
  ON CONFLICT DO NOTHING
  RETURNING bootstrap_request_id
`;

const CONSUME_CHALLENGE_SQL = `
  UPDATE cloud_run_runtime_bootstraps
  SET
    claim_digest = ?5,
    session_id = ?6,
    session_token_hash = ?7,
    session_issued_at = ?8,
    session_expires_at = ?9,
    updated_at = ?4
  WHERE bootstrap_request_id = ?1
    AND execution_handle = ?2
    AND challenge_id = ?3
    AND challenge_expires_at > ?4
    AND claim_digest IS NULL
    AND session_id IS NULL
    AND revoked_at IS NULL
  RETURNING bootstrap_request_id
`;

function mapBootstrap(untrusted: unknown): RuntimeBootstrapRecord {
  const row = bootstrapRowSchema.parse(untrusted);
  return {
    bootstrapRequestId: row.bootstrap_request_id,
    challengeExpiresAt: row.challenge_expires_at,
    challengeHash: row.challenge_hash,
    challengeId: row.challenge_id,
    claimDigest: row.claim_digest,
    executionHandle: row.execution_handle,
    executionName: row.execution_name,
    jobName: row.job_name,
    lastSequence: row.last_sequence,
    publicKey: row.public_key,
    publicKeyDigest: row.public_key_digest,
    requestDigest: row.request_digest,
    revokedAt: row.revoked_at,
    sessionExpiresAt: row.session_expires_at,
    sessionId: row.session_id,
    sessionIssuedAt: row.session_issued_at,
    sessionTokenHash: row.session_token_hash,
    terminalDigest: row.terminal_digest,
  };
}

function mapAttempt(
  untrusted: unknown,
  environment: "staging" | "production",
): RuntimeAttemptContext {
  const row = attemptRowSchema.parse(untrusted);
  const source = parseSourceObjectKey(row.source_key);
  const expectedResultPrefix =
    source === undefined
      ? undefined
      : `results/${source.ownerHash}/${row.job_id}/${row.attempt_id}/`;
  if (
    source?.jobId !== row.job_id ||
    row.result_prefix !== expectedResultPrefix ||
    row.source_size_bytes !== row.expected_size_bytes
  ) {
    throw new Error("Cloud Run runtime attempt compatibility check failed");
  }
  let parsedOptions: unknown;
  try {
    parsedOptions = JSON.parse(row.execution_options_json) as unknown;
  } catch {
    throw new Error("Cloud Run runtime attempt compatibility check failed");
  }
  return {
    attemptId: row.attempt_id,
    cancelRequested:
      row.execution_status === "CANCEL_REQUESTED" ||
      row.attempt_status === "CANCEL_REQUESTED" ||
      row.job_status === "CANCEL_REQUESTED",
    environment,
    executionHandle: row.execution_handle,
    jobId: row.job_id,
    options: boundedExecutionOptionsSchema.parse(parsedOptions),
    ownerHash: source.ownerHash,
    sourceEtag: row.source_etag,
    sourceKey: row.source_key,
    sourceSizeBytes: row.source_size_bytes,
    status:
      row.revoked_at !== null
        ? "TERMINAL_REPORTED"
        : row.session_id !== null && row.claim_digest !== null
          ? "RUNNING"
          : "PENDING_BOOTSTRAP",
  };
}

function sameAttempt(left: RuntimeAttemptContext, right: RuntimeAttemptContext): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.environment === right.environment &&
    left.executionHandle === right.executionHandle &&
    left.jobId === right.jobId &&
    left.status === right.status &&
    left.cancelRequested === right.cancelRequested &&
    left.ownerHash === right.ownerHash &&
    left.sourceEtag === right.sourceEtag &&
    left.sourceKey === right.sourceKey &&
    left.sourceSizeBytes === right.sourceSizeBytes &&
    JSON.stringify(left.options) === JSON.stringify(right.options)
  );
}

function sessionPayload(event: RuntimeSessionEvent): readonly unknown[] {
  if (event.kind === "ack") return [null, null, null, null, null, null];
  if (event.kind === "heartbeat") {
    return [event.request.progress, null, null, null, null, null];
  }
  return [
    null,
    event.request.status,
    event.request.errorCode,
    event.request.artifactCount,
    event.request.durationSeconds,
    event.request.manifestWritten ? 1 : 0,
    event.request.segmentCount,
  ];
}

export class D1CloudRunRuntimeStore implements CloudRunRuntimeStore {
  readonly #database: D1Database;
  readonly #environment: "staging" | "production";

  constructor(database: D1Database, environment: "staging" | "production") {
    this.#database = database;
    this.#environment = runtimeEnvironmentSchema.parse(environment);
  }

  async getAttempt(executionHandle: string): Promise<RuntimeAttemptContext | null> {
    const row = await this.#database
      .withSession("first-primary")
      .prepare(FIND_ATTEMPT_SQL)
      .bind(cloudRunOpaqueHandleSchema.parse(executionHandle))
      .first();
    return row === null ? null : mapAttempt(row, this.#environment);
  }

  async getBootstrap(bootstrapRequestId: string): Promise<RuntimeBootstrapRecord | null> {
    return this.#getBootstrapWhere(
      "bootstrap_request_id = ?1",
      ulidSchema.parse(bootstrapRequestId),
    );
  }

  async beginBootstrap(input: {
    readonly context: RuntimeAttemptContext;
    readonly now: string;
    readonly record: RuntimeBootstrapRecord;
  }): Promise<BeginBootstrapResult> {
    const now = utcDateTimeSchema.parse(input.now);
    const existing = await this.getBootstrap(input.record.bootstrapRequestId);
    if (existing !== null) {
      return existing.requestDigest === input.record.requestDigest &&
        existing.executionHandle === input.record.executionHandle
        ? { outcome: "duplicate", record: existing }
        : { outcome: "conflict" };
    }
    const context = await this.getAttempt(input.record.executionHandle);
    if (
      context?.status !== "PENDING_BOOTSTRAP" ||
      context.cancelRequested ||
      !sameAttempt(context, input.context)
    ) {
      return { outcome: "not_found" };
    }
    const record = mapBootstrap({
      bootstrap_request_id: input.record.bootstrapRequestId,
      challenge_expires_at: input.record.challengeExpiresAt,
      challenge_hash: input.record.challengeHash,
      challenge_id: input.record.challengeId,
      claim_digest: input.record.claimDigest,
      execution_handle: input.record.executionHandle,
      execution_name: input.record.executionName,
      job_name: input.record.jobName,
      last_sequence: input.record.lastSequence,
      public_key: input.record.publicKey,
      public_key_digest: input.record.publicKeyDigest,
      request_digest: input.record.requestDigest,
      revoked_at: input.record.revokedAt,
      session_expires_at: input.record.sessionExpiresAt,
      session_id: input.record.sessionId,
      session_issued_at: input.record.sessionIssuedAt,
      session_token_hash: input.record.sessionTokenHash,
      terminal_digest: input.record.terminalDigest,
    });
    if (
      record.sessionId !== null ||
      record.claimDigest !== null ||
      record.lastSequence !== -1 ||
      record.revokedAt !== null
    ) {
      return { outcome: "conflict" };
    }
    const result = await this.#database
      .prepare(INSERT_BOOTSTRAP_SQL)
      .bind(
        record.bootstrapRequestId,
        record.requestDigest,
        record.executionHandle,
        record.executionName,
        record.jobName,
        record.publicKey,
        record.publicKeyDigest,
        record.challengeId,
        record.challengeHash,
        record.challengeExpiresAt,
        now,
        context.attemptId,
        context.jobId,
      )
      .all();
    const inserted = returnedBootstrapRowsSchema.parse(result.results)[0];
    if (inserted !== undefined) {
      const stored = await this.getBootstrap(inserted.bootstrap_request_id);
      if (stored === null) throw new Error("Cloud Run bootstrap write was not observable");
      return { outcome: "accepted", record: stored };
    }
    const replay = await this.getBootstrap(record.bootstrapRequestId);
    if (replay !== null) {
      return replay.requestDigest === record.requestDigest &&
        replay.executionHandle === record.executionHandle
        ? { outcome: "duplicate", record: replay }
        : { outcome: "conflict" };
    }
    const competing = await this.#getBootstrapWhere(
      "execution_handle = ?1",
      record.executionHandle,
    );
    return competing === null ? { outcome: "not_found" } : { outcome: "conflict" };
  }

  async consumeChallenge(input: {
    readonly bootstrapRequestId: string;
    readonly challengeId: string;
    readonly claimDigest: string;
    readonly executionHandle: string;
    readonly now: string;
    readonly sessionId: string;
    readonly sessionTokenHash: string;
    readonly sessionIssuedAt: string;
    readonly sessionExpiresAt: string;
  }): Promise<ConsumeChallengeResult> {
    const parsed = {
      bootstrapRequestId: ulidSchema.parse(input.bootstrapRequestId),
      challengeId: ulidSchema.parse(input.challengeId),
      claimDigest: runtimeDigestSchema.parse(input.claimDigest),
      executionHandle: cloudRunOpaqueHandleSchema.parse(input.executionHandle),
      now: utcDateTimeSchema.parse(input.now),
      sessionExpiresAt: utcDateTimeSchema.parse(input.sessionExpiresAt),
      sessionId: ulidSchema.parse(input.sessionId),
      sessionIssuedAt: utcDateTimeSchema.parse(input.sessionIssuedAt),
      sessionTokenHash: runtimeDigestSchema.parse(input.sessionTokenHash),
    };
    const existing = await this.getBootstrap(parsed.bootstrapRequestId);
    if (existing === null) return { outcome: "not_found" };
    if (
      existing.executionHandle !== parsed.executionHandle ||
      existing.challengeId !== parsed.challengeId
    ) {
      return { outcome: "conflict" };
    }
    if (existing.claimDigest !== null) {
      return existing.claimDigest === parsed.claimDigest
        ? { outcome: "duplicate", record: existing }
        : { outcome: "conflict" };
    }
    if (Date.parse(existing.challengeExpiresAt) <= Date.parse(parsed.now)) {
      return { outcome: "expired" };
    }
    const result = await this.#database
      .prepare(CONSUME_CHALLENGE_SQL)
      .bind(
        parsed.bootstrapRequestId,
        parsed.executionHandle,
        parsed.challengeId,
        parsed.now,
        parsed.claimDigest,
        parsed.sessionId,
        parsed.sessionTokenHash,
        parsed.sessionIssuedAt,
        parsed.sessionExpiresAt,
      )
      .all();
    const updated = returnedBootstrapRowsSchema.parse(result.results)[0];
    const current = await this.getBootstrap(parsed.bootstrapRequestId);
    if (updated !== undefined) {
      if (current === null) throw new Error("Cloud Run claim write was not observable");
      return { outcome: "accepted", record: current };
    }
    if (current === null) return { outcome: "not_found" };
    if (current.claimDigest === parsed.claimDigest) {
      return { outcome: "duplicate", record: current };
    }
    return Date.parse(current.challengeExpiresAt) <= Date.parse(parsed.now)
      ? { outcome: "expired" }
      : { outcome: "conflict" };
  }

  async applySessionEvent(input: {
    readonly event: RuntimeSessionEvent;
    readonly digest: string;
    readonly tokenHash: string;
    readonly now: string;
  }): Promise<ApplySessionEventResult> {
    const request = input.event.request;
    const parsed = {
      digest: runtimeDigestSchema.parse(input.digest),
      executionHandle: cloudRunOpaqueHandleSchema.parse(request.executionHandle),
      now: utcDateTimeSchema.parse(input.now),
      sequence: z.number().int().nonnegative().parse(request.sequence),
      sessionId: ulidSchema.parse(request.sessionId),
      tokenHash: runtimeDigestSchema.parse(input.tokenHash),
    };
    const replay = await this.#findEvent(parsed.sessionId, parsed.sequence);
    if (replay !== null) {
      return this.#replayResult(input.event, parsed.digest, replay);
    }
    const record = await this.#getBootstrapWhere("session_id = ?1", parsed.sessionId);
    const invalid = this.#classifySessionState(record, input.event, parsed);
    if (invalid !== null) return invalid;

    const payload = sessionPayload(input.event);
    const [progress, terminalStatus, terminalErrorCode, artifactCount, durationSeconds] = payload;
    const manifestWritten = payload[5] ?? null;
    const segmentCount = payload[6] ?? null;
    const result = await this.#database
      .prepare(
        `
          INSERT INTO cloud_run_runtime_events (
            bootstrap_request_id,
            session_id,
            sequence,
            kind,
            request_digest,
            progress,
            terminal_status,
            terminal_error_code,
            artifact_count,
            duration_seconds,
            manifest_written,
            segment_count,
            created_at
          )
          SELECT
            bootstrap_request_id,
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            ?6,
            ?7,
            ?8,
            ?9,
            ?10,
            ?11,
            ?12
          FROM cloud_run_runtime_bootstraps
          WHERE session_id = ?1
            AND execution_handle = ?13
            AND session_token_hash = ?14
            AND session_expires_at > ?12
            AND revoked_at IS NULL
            AND last_sequence = ?2 - 1
            AND (
              (?3 = 'ack' AND ?2 = 0 AND last_sequence = -1)
              OR (?3 = 'heartbeat' AND ?2 > 0 AND last_sequence >= 0)
              OR (?3 = 'terminal')
            )
          ON CONFLICT(session_id, sequence) DO NOTHING
          RETURNING bootstrap_request_id
        `,
      )
      .bind(
        parsed.sessionId,
        parsed.sequence,
        input.event.kind,
        parsed.digest,
        progress,
        terminalStatus,
        terminalErrorCode,
        artifactCount,
        durationSeconds,
        manifestWritten,
        segmentCount,
        parsed.now,
        parsed.executionHandle,
        parsed.tokenHash,
      )
      .all();
    const inserted = returnedBootstrapRowsSchema.parse(result.results)[0];
    if (inserted === undefined) {
      const racedReplay = await this.#findEvent(parsed.sessionId, parsed.sequence);
      if (racedReplay !== null) {
        return this.#replayResult(input.event, parsed.digest, racedReplay);
      }
      const current = await this.#getBootstrapWhere("session_id = ?1", parsed.sessionId);
      return this.#classifySessionState(current, input.event, parsed) ?? { outcome: "rejected" };
    }
    const context = await this.getAttempt(parsed.executionHandle);
    if (context === null) throw new Error("Cloud Run runtime event lost its attempt binding");
    return {
      cancelRequested: context.cancelRequested,
      context,
      outcome: "accepted",
    };
  }

  async #findEvent(
    sessionId: string,
    sequence: number,
  ): Promise<z.infer<typeof eventReplayRowSchema> | null> {
    const row = await this.#database
      .withSession("first-primary")
      .prepare(
        `
          SELECT kind, request_digest
          FROM cloud_run_runtime_events
          WHERE session_id = ?1 AND sequence = ?2
        `,
      )
      .bind(sessionId, sequence)
      .first();
    return row === null ? null : eventReplayRowSchema.parse(row);
  }

  async #getBootstrapWhere(
    predicate: "bootstrap_request_id = ?1" | "execution_handle = ?1" | "session_id = ?1",
    value: string,
  ): Promise<RuntimeBootstrapRecord | null> {
    const row = await this.#database
      .withSession("first-primary")
      .prepare(
        `
          SELECT ${BOOTSTRAP_COLUMNS}
          FROM cloud_run_runtime_bootstraps
          WHERE ${predicate}
        `,
      )
      .bind(value)
      .first();
    return row === null ? null : mapBootstrap(row);
  }

  #classifySessionState(
    record: RuntimeBootstrapRecord | null,
    event: RuntimeSessionEvent,
    parsed: {
      readonly executionHandle: string;
      readonly now: string;
      readonly sequence: number;
      readonly sessionId: string;
      readonly tokenHash: string;
    },
  ): Exclude<ApplySessionEventResult, { readonly outcome: "accepted" | "duplicate" }> | null {
    if (
      record?.sessionId !== parsed.sessionId ||
      record.executionHandle !== parsed.executionHandle ||
      record.sessionTokenHash !== parsed.tokenHash ||
      record.sessionExpiresAt === null
    ) {
      return { outcome: "rejected" };
    }
    if (
      Date.parse(record.sessionExpiresAt) <= Date.parse(parsed.now) ||
      record.revokedAt !== null
    ) {
      return { outcome: "expired" };
    }
    if (parsed.sequence !== record.lastSequence + 1) return { outcome: "stale" };
    if (
      (record.lastSequence === -1 && event.kind === "heartbeat") ||
      (record.lastSequence >= 0 && event.kind === "ack") ||
      (event.kind === "ack" && parsed.sequence !== 0)
    ) {
      return { outcome: "stale" };
    }
    return null;
  }

  async #replayResult(
    event: RuntimeSessionEvent,
    digest: string,
    replay: z.infer<typeof eventReplayRowSchema>,
  ): Promise<ApplySessionEventResult> {
    if (replay.kind !== event.kind || replay.request_digest !== digest) {
      return { outcome: "conflict" };
    }
    const context = await this.getAttempt(event.request.executionHandle);
    return context === null
      ? { outcome: "conflict" }
      : {
          cancelRequested: context.cancelRequested,
          context,
          outcome: "duplicate",
        };
  }
}
