import type { ControllerAction, ControllerEnvironment, ControllerErrorCode } from "./contracts.js";
import type { ProviderExecution, ProviderJob } from "./provider.js";

export const CONTROL_STATES = [
  "CREATE_INTENT",
  "CREATE_UNKNOWN",
  "JOB_PENDING",
  "JOB_READY",
  "RUN_INTENT",
  "EXECUTION_PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCEL_PENDING",
  "CANCELLED",
  "CLEANUP_PENDING",
  "CLEANED",
] as const;

export type ControlState = (typeof CONTROL_STATES)[number];

export interface ControlRecord {
  readonly bootstrapRequestId: string;
  readonly environment: ControllerEnvironment;
  readonly executionHandle: string;
  readonly jobId: string;
  readonly state: ControlState;
  readonly version: number;
  readonly createAttempts: number;
  readonly runIntent: boolean;
  readonly cancelIntent: boolean;
  readonly cleanupIntent: boolean;
  readonly job: ProviderJob | null;
  readonly execution: ProviderExecution | null;
  readonly operationRef: string | null;
  readonly errorCode: ControllerErrorCode | null;
  readonly reservedWorstCaseJpy: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provisioningDeadline: string;
  readonly expiresAt: string;
}

export interface SyntheticAuthorization {
  readonly environment: ControllerEnvironment;
  readonly epoch: string;
  readonly validUntil: string;
  readonly maxExecutions: number;
  readonly maxWorstCaseJpy: number;
  readonly maxRequestsPerMinute: number;
  readonly worstCaseJpyPerExecution: number;
}

interface RequestIdentity {
  readonly requestId: string;
  readonly digest: string;
  readonly environment: ControllerEnvironment;
  readonly executionHandle: string;
  readonly action: ControllerAction;
}

export type AdmitCreateResult =
  | { readonly outcome: "accepted"; readonly record: ControlRecord }
  | { readonly outcome: "duplicate"; readonly record: ControlRecord }
  | { readonly outcome: "budget_exhausted" }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "environment_mismatch" }
  | { readonly outcome: "rate_limited" };

export type ClaimRequestResult =
  | { readonly outcome: "accepted"; readonly record: ControlRecord }
  | { readonly outcome: "duplicate"; readonly record: ControlRecord }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "environment_mismatch" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "rate_limited" }
  | { readonly outcome: "stale" };

export interface AdmitCreateInput extends RequestIdentity {
  readonly expectedVersion: 0;
  readonly jobId: string;
  readonly now: string;
  readonly provisioningDeadline: string;
  readonly recordExpiresAt: string;
}

export interface ClaimRequestInput extends RequestIdentity {
  readonly expectedVersion: number;
  readonly now: string;
}

export interface ControlStore {
  admitCreate(input: AdmitCreateInput): Promise<AdmitCreateResult>;
  claimRequest(input: ClaimRequestInput): Promise<ClaimRequestResult>;
  compareAndSet(expectedVersion: number, record: ControlRecord): Promise<boolean>;
  get(executionHandle: string): Promise<ControlRecord | null>;
  listUnclean(environment: ControllerEnvironment): Promise<readonly ControlRecord[]>;
}

type RememberedRequest = RequestIdentity & { readonly acceptedAt: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameRequest(left: RememberedRequest, right: RequestIdentity): boolean {
  return (
    left.digest === right.digest &&
    left.environment === right.environment &&
    left.executionHandle === right.executionHandle &&
    left.action === right.action
  );
}

export class InMemoryControlStore implements ControlStore {
  readonly #authorizations: Readonly<Record<ControllerEnvironment, SyntheticAuthorization>>;
  readonly #records = new Map<string, ControlRecord>();
  readonly #requests = new Map<string, RememberedRequest>();

  constructor(authorizations: Readonly<Record<ControllerEnvironment, SyntheticAuthorization>>) {
    this.#authorizations = authorizations;
  }

  // The in-memory adapter intentionally mirrors the asynchronous durable-store port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async admitCreate(input: AdmitCreateInput): Promise<AdmitCreateResult> {
    const remembered = this.#requests.get(input.requestId);
    if (remembered !== undefined) {
      const record = this.#records.get(remembered.executionHandle);
      if (record !== undefined && sameRequest(remembered, input)) {
        return { outcome: "duplicate", record: clone(record) };
      }
      return { outcome: "conflict" };
    }
    if (this.#records.has(input.executionHandle)) return { outcome: "conflict" };

    const authorization = this.#authorizations[input.environment];
    const now = Date.parse(input.now);
    if (authorization.environment !== input.environment) return { outcome: "environment_mismatch" };
    const existing = [...this.#records.values()].filter(
      (record) => record.environment === input.environment,
    );
    const active = existing.filter((record) => record.state !== "CLEANED").length;
    const reservedCount = existing.length;
    const reservedJpy = existing.reduce((total, record) => total + record.reservedWorstCaseJpy, 0);
    if (
      !Number.isFinite(now) ||
      Date.parse(authorization.validUntil) < now ||
      active >= 1 ||
      authorization.maxExecutions <= reservedCount ||
      authorization.worstCaseJpyPerExecution <= 0 ||
      reservedJpy + authorization.worstCaseJpyPerExecution > authorization.maxWorstCaseJpy
    ) {
      return { outcome: "budget_exhausted" };
    }
    if (this.#isRateLimited(input.environment, now, authorization.maxRequestsPerMinute)) {
      return { outcome: "rate_limited" };
    }

    const record: ControlRecord = {
      bootstrapRequestId: input.requestId,
      environment: input.environment,
      executionHandle: input.executionHandle,
      jobId: input.jobId,
      state: "CREATE_INTENT",
      version: 1,
      createAttempts: 0,
      runIntent: false,
      cancelIntent: false,
      cleanupIntent: false,
      job: null,
      execution: null,
      operationRef: null,
      errorCode: null,
      reservedWorstCaseJpy: authorization.worstCaseJpyPerExecution,
      createdAt: input.now,
      updatedAt: input.now,
      provisioningDeadline: input.provisioningDeadline,
      expiresAt: input.recordExpiresAt,
    };
    this.#records.set(input.executionHandle, clone(record));
    this.#requests.set(input.requestId, { ...clone(input), acceptedAt: input.now });
    return { outcome: "accepted", record };
  }

  // The in-memory adapter intentionally mirrors the asynchronous durable-store port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async claimRequest(input: ClaimRequestInput): Promise<ClaimRequestResult> {
    const remembered = this.#requests.get(input.requestId);
    if (remembered !== undefined) {
      const record = this.#records.get(remembered.executionHandle);
      if (record !== undefined && sameRequest(remembered, input)) {
        return { outcome: "duplicate", record: clone(record) };
      }
      return { outcome: "conflict" };
    }
    const record = this.#records.get(input.executionHandle);
    if (record === undefined) return { outcome: "not_found" };
    if (record.environment !== input.environment) return { outcome: "environment_mismatch" };
    if (record.version !== input.expectedVersion) return { outcome: "stale" };
    const now = Date.parse(input.now);
    const authorization = this.#authorizations[input.environment];
    if (
      !Number.isFinite(now) ||
      this.#isRateLimited(input.environment, now, authorization.maxRequestsPerMinute)
    ) {
      return { outcome: "rate_limited" };
    }
    this.#requests.set(input.requestId, { ...clone(input), acceptedAt: input.now });
    return { outcome: "accepted", record: clone(record) };
  }

  // The in-memory adapter intentionally mirrors the asynchronous durable-store port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async compareAndSet(expectedVersion: number, record: ControlRecord): Promise<boolean> {
    const current = this.#records.get(record.executionHandle);
    if (
      current?.version !== expectedVersion ||
      record.version !== expectedVersion + 1 ||
      record.environment !== current.environment ||
      record.bootstrapRequestId !== current.bootstrapRequestId ||
      record.jobId !== current.jobId ||
      record.createdAt !== current.createdAt ||
      record.reservedWorstCaseJpy !== current.reservedWorstCaseJpy
    ) {
      return false;
    }
    this.#records.set(record.executionHandle, clone(record));
    return true;
  }

  // The in-memory adapter intentionally mirrors the asynchronous durable-store port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(executionHandle: string): Promise<ControlRecord | null> {
    const record = this.#records.get(executionHandle);
    return record === undefined ? null : clone(record);
  }

  // The in-memory adapter intentionally mirrors the asynchronous durable-store port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async listUnclean(environment: ControllerEnvironment): Promise<readonly ControlRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environment === environment && record.state !== "CLEANED")
      .map((record) => clone(record));
  }

  #isRateLimited(
    environment: ControllerEnvironment,
    now: number,
    maxRequestsPerMinute: number,
  ): boolean {
    if (maxRequestsPerMinute <= 0) return true;
    const windowStart = now - 60_000;
    const count = [...this.#requests.values()].filter(
      (request) =>
        request.environment === environment && Date.parse(request.acceptedAt) > windowStart,
    ).length;
    return count >= maxRequestsPerMinute;
  }
}

export function defaultSyntheticAuthorizations(): Readonly<
  Record<ControllerEnvironment, SyntheticAuthorization>
> {
  return {
    staging: {
      environment: "staging",
      epoch: "disabled",
      validUntil: "1970-01-01T00:00:00.000Z",
      maxExecutions: 0,
      maxWorstCaseJpy: 0,
      maxRequestsPerMinute: 0,
      worstCaseJpyPerExecution: 0,
    },
    production: {
      environment: "production",
      epoch: "disabled",
      validUntil: "1970-01-01T00:00:00.000Z",
      maxExecutions: 0,
      maxWorstCaseJpy: 0,
      maxRequestsPerMinute: 0,
      worstCaseJpyPerExecution: 0,
    },
  };
}
