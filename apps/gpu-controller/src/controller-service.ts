import type { ControllerClock } from "./authentication.js";
import {
  CLOUD_RUN_RUNTIME_POLICY,
  type CloudRunControllerAttestationRequest,
  type CloudRunControllerAttestationResponse,
} from "@scribe-drop/contracts";
import type {
  ControllerEnvironment,
  ControllerErrorCode,
  ControllerRequest,
  ControllerResponse,
} from "./contracts.js";
import type { ControlRecord, ControlStore } from "./control-store.js";
import {
  createFixedJobManifest,
  deriveJobId,
  manifestsMatch,
  type CloudRunAdminPort,
  type FixedPolicyConfiguration,
  type ProviderExecution,
  type ProviderMutation,
} from "./provider.js";

const PROVISIONING_WINDOW_MS = 5 * 60_000;
const CREATE_RECONCILIATION_DELAY_MS = 5_000;
const RECORD_TTL_MS = 31 * 24 * 60 * 60_000;

type MutableRecordChanges = Partial<
  Pick<
    ControlRecord,
    | "state"
    | "createAttempts"
    | "runIntent"
    | "cancelIntent"
    | "cleanupIntent"
    | "job"
    | "execution"
    | "operationRef"
    | "errorCode"
  >
>;

export class GpuControllerService {
  readonly #clock: ControllerClock;
  readonly #environment: ControllerEnvironment;
  readonly #manifestConfiguration: FixedPolicyConfiguration;
  readonly #provider: CloudRunAdminPort;
  readonly #store: ControlStore;

  constructor(input: {
    readonly environment: ControllerEnvironment;
    readonly manifestConfiguration: FixedPolicyConfiguration;
    readonly clock: ControllerClock;
    readonly provider: CloudRunAdminPort;
    readonly store: ControlStore;
  }) {
    if (input.manifestConfiguration.environment !== input.environment) {
      throw new Error("controller policy environment mismatch");
    }
    this.#environment = input.environment;
    this.#manifestConfiguration = input.manifestConfiguration;
    this.#clock = input.clock;
    this.#provider = input.provider;
    this.#store = input.store;
  }

  async execute(request: ControllerRequest, digest: string): Promise<ControllerResponse> {
    if (request.environment !== this.#environment) {
      return this.#rejected(request, "ENVIRONMENT_MISMATCH");
    }
    if (request.action === "create") return this.#create(request, digest);

    const claim = await this.#store.claimRequest({
      requestId: request.requestId,
      digest,
      environment: request.environment,
      executionHandle: request.executionHandle,
      action: request.action,
      expectedVersion: request.expectedVersion,
      now: this.#clock.now().toISOString(),
    });
    if (claim.outcome === "environment_mismatch") {
      return this.#rejected(request, "ENVIRONMENT_MISMATCH");
    }
    if (claim.outcome === "conflict" || claim.outcome === "not_found") {
      return this.#rejected(request, "CONFLICT");
    }
    if (claim.outcome === "stale") {
      return this.#rejected(request, "STALE_VERSION", claim.record.version);
    }
    if (claim.outcome === "rate_limited") return this.#rejected(request, "RATE_LIMITED");
    if (claim.outcome === "duplicate") return this.#response(request, claim.record);
    let record = claim.record;
    switch (request.action) {
      case "observe":
        record = await this.#observeRecord(record);
        break;
      case "reconcile":
        record = await this.#reconcileRecord(record);
        break;
      case "cancel":
        record = await this.#cancelRecord(record);
        break;
      case "cleanup":
        record = await this.#cleanupRecord(record);
        break;
    }
    return this.#response(request, record);
  }

  async attest(
    request: CloudRunControllerAttestationRequest,
  ): Promise<CloudRunControllerAttestationResponse> {
    const rejected = (
      outcome: "invariant_failure" | "not_found" | "unavailable",
    ): CloudRunControllerAttestationResponse => ({
      attestation: null,
      executionHandle: request.executionHandle,
      outcome,
      requestId: request.requestId,
      schemaVersion: 1,
    });
    if (request.environment !== this.#environment) return rejected("not_found");
    const record = await this.#store.get(request.executionHandle);
    if (record?.environment !== request.environment) return rejected("not_found");
    const [jobRead, executionRead] = await Promise.all([
      this.#provider.getJob(record.jobId),
      this.#provider.listExecutions(record.jobId),
    ]);
    if (jobRead.outcome === "unavailable" || executionRead.outcome === "unavailable") {
      return rejected("unavailable");
    }
    if (jobRead.outcome === "not_found") return rejected("not_found");
    if (executionRead.executions.length !== 1) return rejected("invariant_failure");
    const execution = executionRead.executions[0];
    const jobName = jobRead.job.ref.split("/").at(-1);
    const executionName = execution?.ref.split("/").at(-1);
    if (
      execution === undefined ||
      jobName === undefined ||
      executionName === undefined ||
      execution.jobRef !== jobRead.job.ref
    ) {
      return rejected("invariant_failure");
    }
    const expectedManifest = createFixedJobManifest(
      this.#manifestConfiguration,
      record.executionHandle,
      record.bootstrapRequestId,
    );
    const storedExecutionMatches =
      (record.state === "EXECUTION_PENDING" && record.execution === null) ||
      (record.state === "RUNNING" && record.execution?.uid === execution.uid);
    const storedResourcesMatch =
      record.runIntent && record.job?.uid === jobRead.job.uid && storedExecutionMatches;
    return {
      attestation: {
        activeExecutionCount: 1,
        controllerVersion: record.version,
        environment: record.environment,
        executionHandle: record.executionHandle,
        executionName,
        jobName,
        manifestMatches:
          storedResourcesMatch && manifestsMatch(expectedManifest, jobRead.job.manifest),
        policyId: CLOUD_RUN_RUNTIME_POLICY,
        retriedCount: execution.retriedCount,
        runtimeServiceAccount: this.#manifestConfiguration.runtimeServiceAccount,
        state: execution.status,
        taskCount: execution.taskCount,
      },
      executionHandle: request.executionHandle,
      outcome: "found",
      requestId: request.requestId,
      schemaVersion: 1,
    };
  }

  async reap(environment: ControllerEnvironment): Promise<number> {
    if (environment !== this.#environment) return 0;
    const now = this.#clock.now().getTime();
    const records = await this.#store.listUnclean(environment);
    let processed = 0;
    for (const record of records) {
      if (record.cleanupIntent || Date.parse(record.provisioningDeadline) <= now) {
        await this.#cleanupRecord(record);
        processed += 1;
      }
    }
    return processed;
  }

  async #create(request: ControllerRequest, digest: string): Promise<ControllerResponse> {
    if (request.expectedVersion !== 0) return this.#rejected(request, "STALE_VERSION");
    const now = this.#clock.now();
    const jobId = await deriveJobId(request.environment, request.executionHandle);
    const admission = await this.#store.admitCreate({
      requestId: request.requestId,
      digest,
      environment: request.environment,
      executionHandle: request.executionHandle,
      action: request.action,
      expectedVersion: 0,
      jobId,
      now: now.toISOString(),
      provisioningDeadline: new Date(now.getTime() + PROVISIONING_WINDOW_MS).toISOString(),
      recordExpiresAt: new Date(now.getTime() + RECORD_TTL_MS).toISOString(),
    });
    if (admission.outcome === "budget_exhausted") {
      return this.#rejected(request, "BUDGET_EXHAUSTED");
    }
    if (admission.outcome === "environment_mismatch") {
      return this.#rejected(request, "ENVIRONMENT_MISMATCH");
    }
    if (admission.outcome === "rate_limited") return this.#rejected(request, "RATE_LIMITED");
    if (admission.outcome === "conflict") return this.#rejected(request, "CONFLICT");
    if (admission.outcome === "duplicate") return this.#response(request, admission.record);
    return this.#response(request, await this.#sendCreate(admission.record));
  }

  async #sendCreate(record: ControlRecord): Promise<ControlRecord> {
    const claimed = await this.#tryUpdate(record, {
      state: "CREATE_INTENT",
      createAttempts: record.createAttempts + 1,
      errorCode: null,
    });
    if (!claimed.applied) return claimed.record;
    const intent = claimed.record;
    const manifest = createFixedJobManifest(
      this.#manifestConfiguration,
      intent.executionHandle,
      intent.bootstrapRequestId,
    );
    const result = await this.#provider.createJob(intent.jobId, manifest);
    if (result.outcome === "accepted") {
      return this.#update(intent, {
        state: "JOB_PENDING",
        operationRef: result.operationRef,
        errorCode: null,
      });
    }
    if (result.outcome === "conflict") return this.#reconcileJob(intent, true);
    if (result.outcome === "unknown") {
      return this.#update(intent, { state: "CREATE_UNKNOWN", errorCode: "UNKNOWN_OUTCOME" });
    }
    return this.#update(intent, {
      state: "FAILED",
      errorCode: result.errorKind === "retryable" ? "PROVIDER_RETRYABLE" : "PROVIDER_PERMANENT",
    });
  }

  async #reconcileRecord(record: ControlRecord): Promise<ControlRecord> {
    if (
      record.state === "CLEANED" ||
      record.state === "CANCELLED" ||
      record.state === "SUCCEEDED"
    ) {
      return record;
    }
    if (record.cleanupIntent || record.state === "CLEANUP_PENDING") {
      return this.#cleanupRecord(record);
    }
    if (record.state === "FAILED") return record;
    if (!record.runIntent) return this.#reconcileJob(record, true);
    return this.#observeExecution(record);
  }

  async #reconcileJob(record: ControlRecord, allowRun: boolean): Promise<ControlRecord> {
    let operationFailed: "permanent" | "retryable" | null = null;
    if (record.operationRef !== null) {
      const operation = await this.#provider.getOperation(record.operationRef);
      if (operation.outcome === "failed") operationFailed = operation.errorKind;
    }
    const read = await this.#provider.getJob(record.jobId);
    if (read.outcome === "unavailable") {
      return this.#update(record, { errorCode: "UNKNOWN_OUTCOME" });
    }
    if (read.outcome === "not_found") {
      if (operationFailed !== null) {
        return this.#update(record, {
          state: "FAILED",
          errorCode: operationFailed === "retryable" ? "PROVIDER_RETRYABLE" : "PROVIDER_PERMANENT",
        });
      }
      const elapsed = this.#clock.now().getTime() - Date.parse(record.createdAt);
      if (
        record.createAttempts < 2 &&
        (record.createAttempts === 0 || elapsed >= CREATE_RECONCILIATION_DELAY_MS) &&
        this.#clock.now().getTime() < Date.parse(record.provisioningDeadline)
      ) {
        return this.#sendCreate(record);
      }
      return this.#update(record, { state: "CREATE_UNKNOWN", errorCode: "UNKNOWN_OUTCOME" });
    }

    const expected = createFixedJobManifest(
      this.#manifestConfiguration,
      record.executionHandle,
      record.bootstrapRequestId,
    );
    if (!manifestsMatch(expected, read.job.manifest)) {
      return this.#update(record, {
        state: "FAILED",
        job: read.job,
        cleanupIntent: true,
        errorCode: "RESOURCE_DRIFT",
      });
    }
    let current = await this.#update(record, {
      state: read.job.ready ? "JOB_READY" : "JOB_PENDING",
      job: read.job,
      errorCode: null,
    });
    if (!read.job.ready || !allowRun || current.runIntent) return current;

    const executions = await this.#provider.listExecutions(current.jobId);
    if (executions.outcome === "unavailable") {
      return this.#update(current, { errorCode: "UNKNOWN_OUTCOME" });
    }
    if (executions.executions.length > 0)
      return this.#handleExecutionList(current, executions.executions);

    const claimed = await this.#tryUpdate(current, { state: "RUN_INTENT", runIntent: true });
    current = claimed.record;
    if (!claimed.applied || current.job === null) return current;
    const result = await this.#provider.runJob(current.job);
    return this.#recordRunMutation(current, result);
  }

  async #recordRunMutation(
    record: ControlRecord,
    result: ProviderMutation,
  ): Promise<ControlRecord> {
    if (result.outcome === "accepted") {
      return this.#update(record, {
        state: "EXECUTION_PENDING",
        operationRef: result.operationRef,
        errorCode: null,
      });
    }
    if (result.outcome === "unknown") {
      return this.#update(record, { state: "EXECUTION_PENDING", errorCode: "UNKNOWN_OUTCOME" });
    }
    return this.#update(record, {
      state: "FAILED",
      errorCode:
        result.outcome === "conflict"
          ? "CONFLICT"
          : result.errorKind === "retryable"
            ? "PROVIDER_RETRYABLE"
            : "PROVIDER_PERMANENT",
    });
  }

  async #observeRecord(record: ControlRecord): Promise<ControlRecord> {
    if (!record.runIntent) return this.#reconcileJob(record, false);
    return this.#observeExecution(record);
  }

  async #observeExecution(record: ControlRecord): Promise<ControlRecord> {
    const result = await this.#provider.listExecutions(record.jobId);
    if (result.outcome === "unavailable") {
      return this.#update(record, { errorCode: "UNKNOWN_OUTCOME" });
    }
    return this.#handleExecutionList(record, result.executions);
  }

  async #handleExecutionList(
    record: ControlRecord,
    executions: readonly ProviderExecution[],
  ): Promise<ControlRecord> {
    if (executions.length === 0) {
      return this.#update(record, { state: "EXECUTION_PENDING", errorCode: null });
    }
    if (executions.length > 1) {
      for (const execution of executions) await this.#provider.cancelExecution(execution);
      return this.#update(record, {
        state: "FAILED",
        cleanupIntent: true,
        errorCode: "MULTIPLE_EXECUTIONS",
      });
    }
    const execution = executions[0];
    if (execution === undefined || execution.jobRef !== record.job?.ref) {
      if (execution !== undefined) await this.#provider.cancelExecution(execution);
      return this.#update(record, {
        state: "FAILED",
        cleanupIntent: true,
        errorCode: "RESOURCE_DRIFT",
      });
    }
    const states = {
      pending: "EXECUTION_PENDING",
      running: "RUNNING",
      succeeded: "SUCCEEDED",
      failed: "FAILED",
      cancelled: "CANCELLED",
    } as const;
    return this.#update(record, {
      state: states[execution.status],
      execution,
      errorCode: execution.status === "failed" ? "PROVIDER_PERMANENT" : null,
    });
  }

  async #cancelRecord(record: ControlRecord): Promise<ControlRecord> {
    let current = record;
    if (current.execution === null || current.cancelIntent) {
      current = await this.#observeExecution(current);
    }
    if (
      current.execution === null ||
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(current.state)
    ) {
      return current.execution === null
        ? this.#update(current, { state: "CANCEL_PENDING", cancelIntent: true })
        : current;
    }
    const claimed = await this.#tryUpdate(current, {
      state: "CANCEL_PENDING",
      cancelIntent: true,
    });
    current = claimed.record;
    if (!claimed.applied) return current;
    const execution = current.execution;
    if (execution === null) return current;
    const result = await this.#provider.cancelExecution(execution);
    if (result.outcome === "rejected" && result.errorKind === "permanent") {
      return this.#update(current, { errorCode: "PROVIDER_PERMANENT" });
    }
    return this.#update(current, {
      errorCode: result.outcome === "unknown" ? "UNKNOWN_OUTCOME" : null,
    });
  }

  async #cleanupRecord(record: ControlRecord): Promise<ControlRecord> {
    let current = record.cleanupIntent
      ? record
      : await this.#update(record, { state: "CLEANUP_PENDING", cleanupIntent: true });
    const listed = await this.#provider.listExecutions(current.jobId);
    if (listed.outcome === "unavailable") {
      return this.#update(current, { state: "CLEANUP_PENDING", errorCode: "UNKNOWN_OUTCOME" });
    }
    for (const execution of listed.executions) {
      if (execution.status === "pending" || execution.status === "running") {
        await this.#provider.cancelExecution(execution);
      }
      await this.#provider.deleteExecution(execution);
    }
    const jobRead = await this.#provider.getJob(current.jobId);
    if (jobRead.outcome === "unavailable") {
      return this.#update(current, { state: "CLEANUP_PENDING", errorCode: "UNKNOWN_OUTCOME" });
    }
    if (jobRead.outcome === "found") await this.#provider.deleteJob(jobRead.job);

    const afterExecutions = await this.#provider.listExecutions(current.jobId);
    const afterJob = await this.#provider.getJob(current.jobId);
    if (
      afterExecutions.outcome === "found" &&
      afterExecutions.executions.length === 0 &&
      afterJob.outcome === "not_found"
    ) {
      current = await this.#update(current, {
        state: "CLEANED",
        job: null,
        execution: null,
        operationRef: null,
        errorCode: null,
      });
      return current;
    }
    return this.#update(current, { state: "CLEANUP_PENDING", errorCode: "UNKNOWN_OUTCOME" });
  }

  async #update(record: ControlRecord, changes: MutableRecordChanges): Promise<ControlRecord> {
    return (await this.#tryUpdate(record, changes)).record;
  }

  async #tryUpdate(
    record: ControlRecord,
    changes: MutableRecordChanges,
  ): Promise<{ readonly applied: boolean; readonly record: ControlRecord }> {
    const next: ControlRecord = {
      ...record,
      ...changes,
      version: record.version + 1,
      updatedAt: this.#clock.now().toISOString(),
    };
    if (await this.#store.compareAndSet(record.version, next)) {
      return { applied: true, record: next };
    }
    const current = await this.#store.get(record.executionHandle);
    if (current === null) throw new Error("control record disappeared");
    return { applied: false, record: current };
  }

  #response(request: ControllerRequest, record: ControlRecord): ControllerResponse {
    const outcomes = {
      CREATE_INTENT: "accepted",
      CREATE_UNKNOWN: "unknown",
      JOB_PENDING: "pending",
      JOB_READY: "pending",
      RUN_INTENT: "pending",
      EXECUTION_PENDING: "pending",
      RUNNING: "running",
      SUCCEEDED: "succeeded",
      FAILED: "failed",
      CANCEL_PENDING: "pending",
      CANCELLED: "cancelled",
      CLEANUP_PENDING: "pending",
      CLEANED: "cleaned",
    } as const;
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      executionHandle: request.executionHandle,
      outcome: record.errorCode === "UNKNOWN_OUTCOME" ? "unknown" : outcomes[record.state],
      version: record.version,
      errorCode: record.errorCode,
    };
  }

  #rejected(
    request: ControllerRequest,
    errorCode: ControllerErrorCode,
    version = request.expectedVersion,
  ): ControllerResponse {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      executionHandle: request.executionHandle,
      outcome: "rejected",
      version,
      errorCode,
    };
  }
}
