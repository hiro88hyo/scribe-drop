import { Firestore, Timestamp, type Transaction } from "@google-cloud/firestore";
import {
  CLOUD_RUN_CONTROLLER_ERROR_CODES,
  CLOUD_RUN_RUNTIME_POLICY,
  cloudRunOpaqueHandleSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "@scribe-drop/contracts";
import { z } from "zod";

import { cloudRunJobManifestSchema } from "./cloud-run-client.js";
import { CONTROLLER_ACTIONS } from "./contracts.js";
import {
  CONTROL_STATES,
  type AdmitCreateInput,
  type AdmitCreateResult,
  type ClaimRequestInput,
  type ClaimRequestResult,
  type ControlRecord,
  type ControlStore,
  type SyntheticAuthorization,
} from "./control-store.js";
import { providerExecutionStatusSchema } from "./provider.js";

const ENVIRONMENT_COLLECTION = "scribe_drop_controller_environments";
const EXECUTION_COLLECTION = "scribe_drop_controller_executions";
const REQUEST_COLLECTION = "scribe_drop_controller_requests";
const MAX_RECENT_REQUESTS = 120;

export const firestoreSyntheticAuthorizationSchema = z
  .object({
    environment: z.enum(["staging", "production"]),
    epoch: z.string().min(1).max(128),
    validUntil: utcDateTimeSchema,
    maxExecutions: z.number().int().nonnegative().max(100),
    maxWorstCaseJpy: z.number().int().nonnegative().max(10_000_000),
    maxRequestsPerMinute: z.number().int().nonnegative().max(MAX_RECENT_REQUESTS),
    worstCaseJpyPerExecution: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

const providerJobSchema = z
  .object({
    etag: z.string().min(1).max(512),
    manifest: cloudRunJobManifestSchema,
    ready: z.boolean(),
    ref: z.string().min(1).max(512),
    uid: z.uuid(),
  })
  .strict();

const providerExecutionSchema = z
  .object({
    etag: z.string().min(1).max(512),
    jobRef: z.string().min(1).max(512),
    parallelism: z.literal(1),
    ref: z.string().min(1).max(512),
    retriedCount: z.literal(0),
    status: providerExecutionStatusSchema,
    taskCount: z.literal(1),
    uid: z.uuid(),
  })
  .strict();

const controlRecordSchema = z
  .object({
    bootstrapRequestId: ulidSchema,
    cancelIntent: z.boolean(),
    cleanupIntent: z.boolean(),
    createAttempts: z.number().int().nonnegative().max(2),
    createdAt: utcDateTimeSchema,
    environment: z.enum(["staging", "production"]),
    errorCode: z.enum(CLOUD_RUN_CONTROLLER_ERROR_CODES).nullable(),
    execution: providerExecutionSchema.nullable(),
    executionHandle: cloudRunOpaqueHandleSchema,
    expiresAt: utcDateTimeSchema,
    job: providerJobSchema.nullable(),
    jobId: z.string().regex(/^sd-(?:stg|prd)-[a-f0-9]{30}$/u),
    operationRef: z.string().min(1).max(512).nullable(),
    provisioningDeadline: utcDateTimeSchema,
    reservedWorstCaseJpy: z.number().int().positive().max(10_000_000),
    runIntent: z.boolean(),
    state: z.enum(CONTROL_STATES),
    updatedAt: utcDateTimeSchema,
    version: z.number().int().positive(),
  })
  .strict();

const environmentDocumentSchema = firestoreSyntheticAuthorizationSchema
  .extend({
    activeExecutionHandle: cloudRunOpaqueHandleSchema.nullable(),
    activeExecutions: z.number().int().min(0).max(1),
    policyId: z.literal(CLOUD_RUN_RUNTIME_POLICY),
    recentAcceptedAt: z.array(utcDateTimeSchema).max(MAX_RECENT_REQUESTS),
    reservedExecutions: z.number().int().nonnegative().max(100),
    reservedWorstCaseJpy: z.number().int().nonnegative().max(10_000_000),
    schemaVersion: z.literal(1),
    updatedAt: utcDateTimeSchema,
  })
  .superRefine((document, context) => {
    const activeBindingMatches =
      (document.activeExecutions === 0 && document.activeExecutionHandle === null) ||
      (document.activeExecutions === 1 && document.activeExecutionHandle !== null);
    if (!activeBindingMatches) {
      context.addIssue({
        code: "custom",
        message: "active count and execution handle must agree",
        path: ["activeExecutions"],
      });
    }
    if (
      document.reservedExecutions < document.activeExecutions ||
      document.reservedExecutions > document.maxExecutions
    ) {
      context.addIssue({
        code: "custom",
        message: "reserved execution count is outside authorization",
        path: ["reservedExecutions"],
      });
    }
    if (
      document.reservedWorstCaseJpy !==
        document.reservedExecutions * document.worstCaseJpyPerExecution ||
      document.reservedWorstCaseJpy > document.maxWorstCaseJpy
    ) {
      context.addIssue({
        code: "custom",
        message: "reserved cost is outside authorization",
        path: ["reservedWorstCaseJpy"],
      });
    }
  });

const requestDocumentSchema = z
  .object({
    acceptedAt: utcDateTimeSchema,
    action: z.enum(CONTROLLER_ACTIONS),
    digest: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]{43}$/u),
    environment: z.enum(["staging", "production"]),
    executionHandle: cloudRunOpaqueHandleSchema,
    requestId: ulidSchema,
    schemaVersion: z.literal(1),
    ttlExpiresAt: z.date(),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.ttlExpiresAt.getTime() <= Date.parse(document.acceptedAt)) {
      context.addIssue({
        code: "custom",
        message: "request TTL must be after acceptance",
        path: ["ttlExpiresAt"],
      });
    }
  });

const executionDocumentSchema = z
  .object({
    record: controlRecordSchema,
    schemaVersion: z.literal(1),
    ttlExpiresAt: z.date(),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.ttlExpiresAt.toISOString() !== document.record.expiresAt) {
      context.addIssue({
        code: "custom",
        message: "execution TTL must match record expiry",
        path: ["ttlExpiresAt"],
      });
    }
  });

const admitCreateInputSchema = z
  .object({
    action: z.literal("create"),
    digest: requestDocumentSchema.shape.digest,
    environment: z.enum(["staging", "production"]),
    executionHandle: cloudRunOpaqueHandleSchema,
    expectedVersion: z.literal(0),
    jobId: controlRecordSchema.shape.jobId,
    now: utcDateTimeSchema,
    provisioningDeadline: utcDateTimeSchema,
    recordExpiresAt: utcDateTimeSchema,
    requestId: ulidSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const now = Date.parse(input.now);
    const provisioningDeadline = Date.parse(input.provisioningDeadline);
    const recordExpiresAt = Date.parse(input.recordExpiresAt);
    if (provisioningDeadline <= now) {
      context.addIssue({
        code: "custom",
        message: "provisioning deadline must be after admission",
        path: ["provisioningDeadline"],
      });
    }
    if (recordExpiresAt <= provisioningDeadline) {
      context.addIssue({
        code: "custom",
        message: "record expiry must be after provisioning deadline",
        path: ["recordExpiresAt"],
      });
    }
  });

const claimRequestInputSchema = z
  .object({
    action: z.enum(["observe", "reconcile", "cancel", "cleanup"]),
    digest: requestDocumentSchema.shape.digest,
    environment: z.enum(["staging", "production"]),
    executionHandle: cloudRunOpaqueHandleSchema,
    expectedVersion: z.number().int().nonnegative(),
    now: utcDateTimeSchema,
    requestId: ulidSchema,
  })
  .strict();

type EnvironmentDocument = z.infer<typeof environmentDocumentSchema>;
type RequestDocument = z.infer<typeof requestDocumentSchema>;

export interface FirestoreDocumentTransaction {
  create(path: string, data: Readonly<Record<string, unknown>>): void;
  get(path: string): Promise<unknown>;
  set(path: string, data: Readonly<Record<string, unknown>>): void;
}

export interface FirestoreControlDatabase {
  get(path: string): Promise<unknown>;
  runTransaction<T>(
    callback: (transaction: FirestoreDocumentTransaction) => Promise<T>,
  ): Promise<T>;
}

class GoogleFirestoreTransaction implements FirestoreDocumentTransaction {
  readonly #database: Firestore;
  readonly #transaction: Transaction;

  constructor(database: Firestore, transaction: Transaction) {
    this.#database = database;
    this.#transaction = transaction;
  }

  create(path: string, data: Readonly<Record<string, unknown>>): void {
    this.#transaction.create(this.#database.doc(path), data);
  }

  async get(path: string): Promise<unknown> {
    const snapshot = await this.#transaction.get(this.#database.doc(path));
    return snapshot.exists ? normalizeFirestoreDocument(snapshot.data()) : null;
  }

  set(path: string, data: Readonly<Record<string, unknown>>): void {
    this.#transaction.set(this.#database.doc(path), data);
  }
}

export class GoogleFirestoreControlDatabase implements FirestoreControlDatabase {
  readonly #database: Firestore;

  constructor(database: Firestore) {
    this.#database = database;
  }

  async get(path: string): Promise<unknown> {
    const snapshot = await this.#database.doc(path).get();
    return snapshot.exists ? normalizeFirestoreDocument(snapshot.data()) : null;
  }

  runTransaction<T>(
    callback: (transaction: FirestoreDocumentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#database.runTransaction(
      (transaction) => callback(new GoogleFirestoreTransaction(this.#database, transaction)),
      { maxAttempts: 5 },
    );
  }
}

export const firestoreDatabaseConfigurationSchema = z
  .object({
    databaseId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u),
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  })
  .strict();

export function createGoogleFirestoreControlDatabase(input: {
  readonly databaseId: string;
  readonly projectId: string;
}): GoogleFirestoreControlDatabase {
  const configuration = firestoreDatabaseConfigurationSchema.parse(input);
  return new GoogleFirestoreControlDatabase(
    new Firestore({
      databaseId: configuration.databaseId,
      ignoreUndefinedProperties: false,
      maxIdleChannels: 0,
      preferRest: true,
      projectId: configuration.projectId,
    }),
  );
}

function normalizeFirestoreDocument(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(normalizeFirestoreDocument);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeFirestoreDocument(item)]),
    );
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function environmentPath(environment: "staging" | "production"): string {
  return `${ENVIRONMENT_COLLECTION}/${environment}`;
}

function executionPath(executionHandle: string): string {
  return `${EXECUTION_COLLECTION}/${executionHandle}`;
}

function requestPath(requestId: string): string {
  return `${REQUEST_COLLECTION}/${requestId}`;
}

function sameAuthorization(
  document: EnvironmentDocument,
  authorization: SyntheticAuthorization,
): boolean {
  return (
    document.environment === authorization.environment &&
    document.epoch === authorization.epoch &&
    document.validUntil === authorization.validUntil &&
    document.maxExecutions === authorization.maxExecutions &&
    document.maxWorstCaseJpy === authorization.maxWorstCaseJpy &&
    document.maxRequestsPerMinute === authorization.maxRequestsPerMinute &&
    document.worstCaseJpyPerExecution === authorization.worstCaseJpyPerExecution
  );
}

function sameRequest(
  document: RequestDocument,
  input: Pick<
    AdmitCreateInput | ClaimRequestInput,
    "action" | "digest" | "environment" | "executionHandle" | "requestId"
  >,
): boolean {
  return (
    document.action === input.action &&
    document.digest === input.digest &&
    document.environment === input.environment &&
    document.executionHandle === input.executionHandle &&
    document.requestId === input.requestId
  );
}

function pruneRecent(document: EnvironmentDocument, nowMs: number): readonly string[] {
  const windowStart = nowMs - 60_000;
  return document.recentAcceptedAt.filter((value) => Date.parse(value) > windowStart);
}

function recordDocument(record: ControlRecord): Readonly<Record<string, unknown>> {
  const parsed = controlRecordSchema.parse(record);
  return {
    record: parsed,
    schemaVersion: 1,
    ttlExpiresAt: new Date(parsed.expiresAt),
  };
}

function parseRecordDocument(value: unknown, expectedExecutionHandle: string): ControlRecord {
  const record = executionDocumentSchema.parse(value).record;
  if (record.executionHandle !== expectedExecutionHandle) {
    throw new Error("Firestore controller record path binding mismatch");
  }
  return clone(record);
}

export function createFirestoreEnvironmentDocument(
  authorization: SyntheticAuthorization,
  now: string,
): Readonly<Record<string, unknown>> {
  return environmentDocumentSchema.parse({
    ...firestoreSyntheticAuthorizationSchema.parse(authorization),
    activeExecutionHandle: null,
    activeExecutions: 0,
    policyId: CLOUD_RUN_RUNTIME_POLICY,
    recentAcceptedAt: [],
    reservedExecutions: 0,
    reservedWorstCaseJpy: 0,
    schemaVersion: 1,
    updatedAt: utcDateTimeSchema.parse(now),
  });
}

export class FirestoreControlStore implements ControlStore {
  readonly #authorization: SyntheticAuthorization;
  readonly #database: FirestoreControlDatabase;

  constructor(authorization: SyntheticAuthorization, database: FirestoreControlDatabase) {
    this.#authorization = clone(firestoreSyntheticAuthorizationSchema.parse(authorization));
    this.#database = database;
  }

  async admitCreate(input: AdmitCreateInput): Promise<AdmitCreateResult> {
    const request = admitCreateInputSchema.parse(input);
    if (request.environment !== this.#authorization.environment) {
      return { outcome: "environment_mismatch" };
    }
    return this.#database.runTransaction(async (transaction) => {
      const [environmentValue, requestValue, executionValue] = await Promise.all([
        transaction.get(environmentPath(request.environment)),
        transaction.get(requestPath(request.requestId)),
        transaction.get(executionPath(request.executionHandle)),
      ]);
      const environment = environmentDocumentSchema.parse(environmentValue);
      if (!sameAuthorization(environment, this.#authorization)) {
        return { outcome: "environment_mismatch" };
      }
      if (requestValue !== null) {
        const remembered = requestDocumentSchema.parse(requestValue);
        if (sameRequest(remembered, request) && executionValue !== null) {
          const record = parseRecordDocument(executionValue, request.executionHandle);
          if (record.bootstrapRequestId !== request.requestId) {
            throw new Error("Firestore controller bootstrap request binding mismatch");
          }
          return { outcome: "duplicate", record };
        }
        return { outcome: "conflict" };
      }
      if (executionValue !== null) return { outcome: "conflict" };
      const nowMs = Date.parse(request.now);
      const recent = pruneRecent(environment, nowMs);
      if (
        !Number.isFinite(nowMs) ||
        Date.parse(environment.validUntil) < nowMs ||
        environment.activeExecutions !== 0 ||
        environment.activeExecutionHandle !== null ||
        environment.reservedExecutions >= environment.maxExecutions ||
        environment.worstCaseJpyPerExecution <= 0 ||
        environment.reservedWorstCaseJpy + environment.worstCaseJpyPerExecution >
          environment.maxWorstCaseJpy
      ) {
        return { outcome: "budget_exhausted" };
      }
      if (
        environment.maxRequestsPerMinute <= 0 ||
        recent.length >= environment.maxRequestsPerMinute
      ) {
        return { outcome: "rate_limited" };
      }
      const record = controlRecordSchema.parse({
        bootstrapRequestId: request.requestId,
        cancelIntent: false,
        cleanupIntent: false,
        createAttempts: 0,
        createdAt: request.now,
        environment: request.environment,
        errorCode: null,
        execution: null,
        executionHandle: request.executionHandle,
        expiresAt: request.recordExpiresAt,
        job: null,
        jobId: request.jobId,
        operationRef: null,
        provisioningDeadline: request.provisioningDeadline,
        reservedWorstCaseJpy: environment.worstCaseJpyPerExecution,
        runIntent: false,
        state: "CREATE_INTENT",
        updatedAt: request.now,
        version: 1,
      });
      transaction.create(executionPath(request.executionHandle), recordDocument(record));
      transaction.create(
        requestPath(request.requestId),
        requestDocumentSchema.parse({
          acceptedAt: request.now,
          action: request.action,
          digest: request.digest,
          environment: request.environment,
          executionHandle: request.executionHandle,
          requestId: request.requestId,
          schemaVersion: 1,
          ttlExpiresAt: new Date(request.recordExpiresAt),
        }),
      );
      transaction.set(
        environmentPath(request.environment),
        environmentDocumentSchema.parse({
          ...environment,
          activeExecutionHandle: request.executionHandle,
          activeExecutions: 1,
          recentAcceptedAt: [...recent, request.now],
          reservedExecutions: environment.reservedExecutions + 1,
          reservedWorstCaseJpy:
            environment.reservedWorstCaseJpy + environment.worstCaseJpyPerExecution,
          updatedAt: request.now,
        }),
      );
      return { outcome: "accepted", record };
    });
  }

  async claimRequest(input: ClaimRequestInput): Promise<ClaimRequestResult> {
    const request = claimRequestInputSchema.parse(input);
    if (request.environment !== this.#authorization.environment) {
      return { outcome: "environment_mismatch" };
    }
    return this.#database.runTransaction(async (transaction) => {
      const [environmentValue, requestValue, executionValue] = await Promise.all([
        transaction.get(environmentPath(request.environment)),
        transaction.get(requestPath(request.requestId)),
        transaction.get(executionPath(request.executionHandle)),
      ]);
      const environment = environmentDocumentSchema.parse(environmentValue);
      if (!sameAuthorization(environment, this.#authorization)) {
        return { outcome: "environment_mismatch" };
      }
      if (requestValue !== null) {
        const remembered = requestDocumentSchema.parse(requestValue);
        if (sameRequest(remembered, request) && executionValue !== null) {
          return {
            outcome: "duplicate",
            record: parseRecordDocument(executionValue, request.executionHandle),
          };
        }
        return { outcome: "conflict" };
      }
      if (executionValue === null) return { outcome: "not_found" };
      const record = parseRecordDocument(executionValue, request.executionHandle);
      if (record.environment !== request.environment) return { outcome: "environment_mismatch" };
      if (record.version !== request.expectedVersion) return { outcome: "stale", record };
      const nowMs = Date.parse(request.now);
      const recent = pruneRecent(environment, nowMs);
      if (
        !Number.isFinite(nowMs) ||
        environment.maxRequestsPerMinute <= 0 ||
        recent.length >= environment.maxRequestsPerMinute
      ) {
        return { outcome: "rate_limited" };
      }
      transaction.create(
        requestPath(request.requestId),
        requestDocumentSchema.parse({
          acceptedAt: request.now,
          action: request.action,
          digest: request.digest,
          environment: request.environment,
          executionHandle: request.executionHandle,
          requestId: request.requestId,
          schemaVersion: 1,
          ttlExpiresAt: new Date(record.expiresAt),
        }),
      );
      transaction.set(
        environmentPath(request.environment),
        environmentDocumentSchema.parse({
          ...environment,
          recentAcceptedAt: [...recent, request.now],
          updatedAt: request.now,
        }),
      );
      return { outcome: "accepted", record };
    });
  }

  async compareAndSet(expectedVersion: number, record: ControlRecord): Promise<boolean> {
    const next = controlRecordSchema.parse(record);
    if (next.environment !== this.#authorization.environment) return false;
    return this.#database.runTransaction(async (transaction) => {
      const [environmentValue, executionValue] = await Promise.all([
        transaction.get(environmentPath(next.environment)),
        transaction.get(executionPath(next.executionHandle)),
      ]);
      const environment = environmentDocumentSchema.parse(environmentValue);
      if (!sameAuthorization(environment, this.#authorization) || executionValue === null) {
        return false;
      }
      const current = parseRecordDocument(executionValue, next.executionHandle);
      if (
        current.version !== expectedVersion ||
        next.version !== expectedVersion + 1 ||
        next.environment !== current.environment ||
        next.bootstrapRequestId !== current.bootstrapRequestId ||
        next.jobId !== current.jobId ||
        next.createdAt !== current.createdAt ||
        next.expiresAt !== current.expiresAt ||
        next.reservedWorstCaseJpy !== current.reservedWorstCaseJpy ||
        Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
        current.state === "CLEANED"
      ) {
        return false;
      }
      if (
        environment.activeExecutions !== 1 ||
        environment.activeExecutionHandle !== current.executionHandle
      ) {
        return false;
      }
      transaction.set(executionPath(next.executionHandle), recordDocument(next));
      if (next.state === "CLEANED") {
        transaction.set(
          environmentPath(next.environment),
          environmentDocumentSchema.parse({
            ...environment,
            activeExecutionHandle: null,
            activeExecutions: 0,
            updatedAt: next.updatedAt,
          }),
        );
      }
      return true;
    });
  }

  async get(executionHandle: string): Promise<ControlRecord | null> {
    const parsedHandle = cloudRunOpaqueHandleSchema.parse(executionHandle);
    const value = await this.#database.get(executionPath(parsedHandle));
    if (value === null) return null;
    const record = parseRecordDocument(value, parsedHandle);
    if (record.environment !== this.#authorization.environment) {
      throw new Error("Firestore controller record environment mismatch");
    }
    return record;
  }

  async listUnclean(environment: "staging" | "production"): Promise<readonly ControlRecord[]> {
    if (environment !== this.#authorization.environment) return [];
    const environmentValue = await this.#database.get(environmentPath(environment));
    const state = environmentDocumentSchema.parse(environmentValue);
    if (!sameAuthorization(state, this.#authorization)) {
      throw new Error("Firestore controller authorization mismatch");
    }
    if (state.activeExecutionHandle === null) {
      if (state.activeExecutions !== 0) throw new Error("Firestore controller active state drift");
      return [];
    }
    if (state.activeExecutions !== 1) throw new Error("Firestore controller active state drift");
    const value = await this.#database.get(executionPath(state.activeExecutionHandle));
    if (value === null) throw new Error("Firestore controller active record missing");
    const record = parseRecordDocument(value, state.activeExecutionHandle);
    if (record.environment !== environment || record.state === "CLEANED") {
      throw new Error("Firestore controller active record drift");
    }
    return [record];
  }
}
