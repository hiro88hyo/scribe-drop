import type {
  BoundedExecutionOptions,
  CloudRunAckRequest,
  CloudRunClaimResponse,
  CloudRunHeartbeatRequest,
  CloudRunTerminalRequest,
} from "@scribe-drop/contracts";

export interface RuntimeAttemptContext {
  readonly environment: "staging" | "production";
  readonly executionHandle: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly options: BoundedExecutionOptions;
  readonly ownerHash: string;
  readonly sourceEtag: string;
  readonly sourceKey: string;
  readonly sourceSizeBytes: number;
  readonly cancelRequested: boolean;
  readonly status: "PENDING_BOOTSTRAP" | "RUNNING" | "TERMINAL_REPORTED";
}

export interface RuntimeBootstrapRecord {
  readonly bootstrapRequestId: string;
  readonly requestDigest: string;
  readonly executionHandle: string;
  readonly executionName: string;
  readonly jobName: string;
  readonly publicKey: string;
  readonly publicKeyDigest: string;
  readonly challengeId: string;
  readonly challengeHash: string;
  readonly challengeExpiresAt: string;
  readonly sessionId: string | null;
  readonly sessionTokenHash: string | null;
  readonly sessionIssuedAt: string | null;
  readonly sessionExpiresAt: string | null;
  readonly claimDigest: string | null;
  readonly lastSequence: number;
  readonly revokedAt: string | null;
  readonly terminalDigest: string | null;
}

export type BeginBootstrapResult =
  | { readonly outcome: "accepted"; readonly record: RuntimeBootstrapRecord }
  | { readonly outcome: "duplicate"; readonly record: RuntimeBootstrapRecord }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "not_found" };

export type ConsumeChallengeResult =
  | { readonly outcome: "accepted"; readonly record: RuntimeBootstrapRecord }
  | { readonly outcome: "duplicate"; readonly record: RuntimeBootstrapRecord }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "not_found" };

export type RuntimeSessionEvent =
  | { readonly kind: "ack"; readonly request: CloudRunAckRequest }
  | { readonly kind: "heartbeat"; readonly request: CloudRunHeartbeatRequest }
  | { readonly kind: "terminal"; readonly request: CloudRunTerminalRequest };

export type ApplySessionEventResult =
  | {
      readonly outcome: "accepted";
      readonly cancelRequested: boolean;
      readonly context: RuntimeAttemptContext;
    }
  | {
      readonly outcome: "duplicate";
      readonly cancelRequested: boolean;
      readonly context: RuntimeAttemptContext;
    }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "stale" };

export interface CloudRunRuntimeStore {
  applySessionEvent(input: {
    readonly event: RuntimeSessionEvent;
    readonly digest: string;
    readonly tokenHash: string;
    readonly now: string;
  }): Promise<ApplySessionEventResult>;
  beginBootstrap(input: {
    readonly context: RuntimeAttemptContext;
    readonly now: string;
    readonly record: RuntimeBootstrapRecord;
  }): Promise<BeginBootstrapResult>;
  consumeChallenge(input: {
    readonly bootstrapRequestId: string;
    readonly challengeId: string;
    readonly claimDigest: string;
    readonly executionHandle: string;
    readonly now: string;
    readonly sessionId: string;
    readonly sessionTokenHash: string;
    readonly sessionIssuedAt: string;
    readonly sessionExpiresAt: string;
  }): Promise<ConsumeChallengeResult>;
  getAttempt(executionHandle: string): Promise<RuntimeAttemptContext | null>;
  getBootstrap(bootstrapRequestId: string): Promise<RuntimeBootstrapRecord | null>;
}

interface StoredSessionEvent {
  readonly digest: string;
  readonly kind: RuntimeSessionEvent["kind"];
  readonly sequence: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryCloudRunRuntimeStore implements CloudRunRuntimeStore {
  readonly #attempts = new Map<string, RuntimeAttemptContext>();
  readonly #bootstraps = new Map<string, RuntimeBootstrapRecord>();
  readonly #events = new Map<string, StoredSessionEvent>();

  constructor(attempts: readonly RuntimeAttemptContext[]) {
    for (const attempt of attempts) this.#attempts.set(attempt.executionHandle, clone(attempt));
  }

  // The local D1 fake mirrors the asynchronous production repository port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async getAttempt(executionHandle: string): Promise<RuntimeAttemptContext | null> {
    const attempt = this.#attempts.get(executionHandle);
    return attempt === undefined ? null : clone(attempt);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBootstrap(bootstrapRequestId: string): Promise<RuntimeBootstrapRecord | null> {
    const record = this.#bootstraps.get(bootstrapRequestId);
    return record === undefined ? null : clone(record);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async beginBootstrap(input: {
    readonly context: RuntimeAttemptContext;
    readonly now: string;
    readonly record: RuntimeBootstrapRecord;
  }): Promise<BeginBootstrapResult> {
    const existing = this.#bootstraps.get(input.record.bootstrapRequestId);
    if (existing !== undefined) {
      return existing.requestDigest === input.record.requestDigest &&
        existing.executionHandle === input.record.executionHandle
        ? { outcome: "duplicate", record: clone(existing) }
        : { outcome: "conflict" };
    }
    const attempt = this.#attempts.get(input.record.executionHandle);
    if (
      attempt?.status !== "PENDING_BOOTSTRAP" ||
      attempt.jobId !== input.context.jobId ||
      attempt.attemptId !== input.context.attemptId
    ) {
      return { outcome: "not_found" };
    }
    this.#bootstraps.set(input.record.bootstrapRequestId, clone(input.record));
    return { outcome: "accepted", record: clone(input.record) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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
    const record = this.#bootstraps.get(input.bootstrapRequestId);
    if (record === undefined) return { outcome: "not_found" };
    if (
      record.executionHandle !== input.executionHandle ||
      record.challengeId !== input.challengeId
    ) {
      return { outcome: "conflict" };
    }
    if (record.claimDigest !== null) {
      return record.claimDigest === input.claimDigest
        ? { outcome: "duplicate", record: clone(record) }
        : { outcome: "conflict" };
    }
    if (Date.parse(record.challengeExpiresAt) <= Date.parse(input.now)) {
      return { outcome: "expired" };
    }
    const claimed: RuntimeBootstrapRecord = {
      ...record,
      sessionId: input.sessionId,
      sessionTokenHash: input.sessionTokenHash,
      sessionIssuedAt: input.sessionIssuedAt,
      sessionExpiresAt: input.sessionExpiresAt,
      claimDigest: input.claimDigest,
    };
    this.#bootstraps.set(input.bootstrapRequestId, clone(claimed));
    const attempt = this.#attempts.get(record.executionHandle);
    if (attempt !== undefined) {
      this.#attempts.set(record.executionHandle, { ...attempt, status: "RUNNING" });
    }
    return { outcome: "accepted", record: clone(claimed) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async applySessionEvent(input: {
    readonly event: RuntimeSessionEvent;
    readonly digest: string;
    readonly tokenHash: string;
    readonly now: string;
  }): Promise<ApplySessionEventResult> {
    const request = input.event.request;
    const eventKey = `${request.sessionId}:${input.event.kind}:${String(request.sequence)}`;
    const replay = this.#events.get(eventKey);
    const record = [...this.#bootstraps.values()].find(
      (candidate) => candidate.sessionId === request.sessionId,
    );
    if (replay !== undefined) {
      const context = record === undefined ? undefined : this.#attempts.get(record.executionHandle);
      return replay.digest === input.digest && context !== undefined
        ? {
            outcome: "duplicate",
            cancelRequested: context.cancelRequested,
            context: clone(context),
          }
        : { outcome: "conflict" };
    }
    if (record?.executionHandle !== request.executionHandle) {
      return { outcome: "rejected" };
    }
    if (record.sessionTokenHash !== input.tokenHash || record.sessionExpiresAt === null) {
      return { outcome: "rejected" };
    }
    if (Date.parse(record.sessionExpiresAt) <= Date.parse(input.now) || record.revokedAt !== null) {
      return { outcome: "expired" };
    }
    if (request.sequence !== record.lastSequence + 1) return { outcome: "stale" };
    if (
      (record.lastSequence === -1 && input.event.kind === "heartbeat") ||
      (record.lastSequence >= 0 && input.event.kind === "ack") ||
      (input.event.kind === "ack" && request.sequence !== 0)
    ) {
      return { outcome: "stale" };
    }
    const context = this.#attempts.get(record.executionHandle);
    if (context === undefined) return { outcome: "rejected" };

    const next: RuntimeBootstrapRecord = {
      ...record,
      lastSequence: request.sequence,
      ...(input.event.kind === "terminal"
        ? { revokedAt: input.now, terminalDigest: input.digest }
        : {}),
    };
    this.#bootstraps.set(record.bootstrapRequestId, next);
    this.#events.set(eventKey, {
      digest: input.digest,
      kind: input.event.kind,
      sequence: request.sequence,
    });
    const nextContext: RuntimeAttemptContext =
      input.event.kind === "terminal" ? { ...context, status: "TERMINAL_REPORTED" } : context;
    this.#attempts.set(context.executionHandle, nextContext);
    return {
      outcome: "accepted",
      cancelRequested: nextContext.cancelRequested,
      context: clone(nextContext),
    };
  }
}

export type RuntimeClaimCapabilities = Pick<CloudRunClaimResponse, "results" | "source">;
