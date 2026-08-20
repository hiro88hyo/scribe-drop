import {
  CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS,
  CLOUD_RUN_RUNTIME_POLICY,
  cloudRunControllerRequestSchema,
  type CloudRunControllerRequest,
  type CloudRunControllerResponse,
} from "@scribe-drop/contracts";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";

import {
  CloudRunControllerClient,
  type CloudRunControllerClientPorts,
} from "./cloud-run-controller-client.js";
import {
  createD1CloudRunControlRepository,
  type CloudRunControlRepository,
  type CloudRunReconciliationCandidate,
} from "./cloud-run-control-repository.js";
import {
  decodeCloudRunRuntimeSecret,
  parseGpuExecutionAdmission,
  parseGpuExecutionSelection,
  parseCloudRunRuntimeServiceConfig,
  type CloudRunRuntimeServiceConfigEnvironment,
  type GpuExecutionAdmissionEnvironment,
  type GpuExecutionSelectionEnvironment,
} from "./config.js";
import {
  submitPendingCloudRunJob,
  type CloudRunSubmissionEnvironment,
} from "./cloud-run-submission-service.js";
import type { SubmissionDispatchResult } from "./runpod-submission-service.js";

const BATCH_SIZE = 25;
const MAX_STALE_VERSION_RECOVERIES = 1;
const REQUEST_LIFETIME_MS = 30_000;
export const MISSING_RUNTIME_TERMINAL_GRACE_MS = 5 * 60 * 1_000;

export interface CloudRunReconciliationEnvironment
  extends
    CloudRunRuntimeServiceConfigEnvironment,
    GpuExecutionAdmissionEnvironment,
    GpuExecutionSelectionEnvironment {
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface CloudRunReconciliationController {
  mutate(request: CloudRunControllerRequest): Promise<CloudRunControllerResponse>;
}

export interface CloudRunReconciliationDependencies {
  readonly createController?: (
    environment: CloudRunReconciliationEnvironment,
    now: () => Date,
  ) => CloudRunReconciliationController;
  readonly createRepository?: (database: D1Database) => CloudRunControlRepository;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly submitPendingJob?: (
    jobId: string,
    environment: CloudRunSubmissionEnvironment,
    logger: StructuredLogger,
  ) => Promise<SubmissionDispatchResult>;
}

export interface CloudRunReconciliationResult {
  readonly appliedCount: number;
  readonly deferredCount: number;
  readonly dispatch: SubmissionDispatchResult | "none";
  readonly failedMissingTerminalCount: number;
}

export interface CloudRunCancellationResult {
  readonly appliedCount: number;
  readonly deferredCount: number;
  readonly outcome: "applied" | "deferred" | "ignored";
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function createController(
  environment: CloudRunReconciliationEnvironment,
  now: () => Date,
): CloudRunReconciliationController | undefined {
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) return undefined;
  const secret = decodeCloudRunRuntimeSecret(config.controllerHmacPrimary);
  if (secret === undefined) return undefined;
  const ports: CloudRunControllerClientPorts = {
    clock: { now },
    fetch,
    ids: {
      next: () => {
        throw new Error("Reconciliation supplies persisted request IDs");
      },
    },
  };
  return new CloudRunControllerClient(
    {
      baseUrl: config.controllerOrigin,
      environment: config.appEnvironment,
      keyId: "primary",
      requestLifetimeMs: REQUEST_LIFETIME_MS,
      secret,
    },
    ports,
  );
}

function action(
  candidate: CloudRunReconciliationCandidate,
): "cancel" | "cleanup" | "observe" | "reconcile" {
  if (
    candidate.jobDeleted ||
    candidate.cleanupStatus !== "NOT_REQUESTED" ||
    candidate.executionStatus === "TERMINAL"
  ) {
    return "cleanup";
  }
  if (
    candidate.jobStatus === "CANCEL_REQUESTED" ||
    candidate.executionStatus === "CANCEL_REQUESTED"
  ) {
    return "cancel";
  }
  return candidate.executionStatus === "CREATING" ? "reconcile" : "observe";
}

function controllerResponseRequiresRetry(response: CloudRunControllerResponse): boolean {
  if (response.outcome === "unknown") return true;
  return (
    response.outcome === "rejected" &&
    response.errorCode !== null &&
    [
      "CONFLICT",
      "INTERNAL_ERROR",
      "PROVIDER_RETRYABLE",
      "RATE_LIMITED",
      "UNKNOWN_OUTCOME",
    ].includes(response.errorCode)
  );
}

async function applyControllerAction(
  candidate: CloudRunReconciliationCandidate,
  selectedAction: "cancel" | "cleanup" | "observe" | "reconcile",
  appEnvironment: "production" | "staging",
  controller: CloudRunReconciliationController,
  repository: CloudRunControlRepository,
  now: () => Date,
  bytes: RandomBytes,
): Promise<{ readonly appliedCount: number; readonly deferredCount: number }> {
  let appliedCount = 0;
  let deferredCount = 0;
  let currentCandidate = candidate;
  for (
    let staleVersionRecovery = 0;
    staleVersionRecovery <= MAX_STALE_VERSION_RECOVERIES;
    staleVersionRecovery += 1
  ) {
    const issuedAt = now();
    const request = cloudRunControllerRequestSchema.parse({
      action: selectedAction,
      environment: appEnvironment,
      executionHandle: currentCandidate.providerHandle,
      expectedVersion: currentCandidate.providerVersion,
      expiresAt: new Date(
        issuedAt.getTime() +
          Math.min(REQUEST_LIFETIME_MS, CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS),
      ).toISOString(),
      issuedAt: issuedAt.toISOString(),
      policyId: CLOUD_RUN_RUNTIME_POLICY,
      requestId: createUlid(issuedAt.getTime(), bytes),
      schemaVersion: 1,
    });
    let response: CloudRunControllerResponse | undefined;
    for (let requestAttempt = 0; requestAttempt < 2; requestAttempt += 1) {
      try {
        response = await controller.mutate(request);
        break;
      } catch {
        // Replay only the exact bounded request so an unknown effect cannot be duplicated.
      }
    }
    if (response === undefined) {
      deferredCount += 1;
      break;
    }
    const responseTimestamp = now().toISOString();
    const applied = await repository.applyControllerResponse({
      action: selectedAction,
      candidate: currentCandidate,
      response,
      timestamp: responseTimestamp,
    });
    if (!applied) {
      deferredCount += 1;
      break;
    }
    appliedCount += 1;
    const staleVersionResponse =
      response.outcome === "rejected" && response.errorCode === "STALE_VERSION";
    if (staleVersionResponse) {
      if (
        response.version === currentCandidate.providerVersion ||
        staleVersionRecovery === MAX_STALE_VERSION_RECOVERIES
      ) {
        deferredCount += 1;
        break;
      }
      currentCandidate = {
        ...currentCandidate,
        executionUpdatedAt: responseTimestamp,
        executionVersion: currentCandidate.executionVersion + 1,
        providerVersion: response.version,
      };
      continue;
    }
    if (controllerResponseRequiresRetry(response)) deferredCount += 1;
    break;
  }
  return { appliedCount, deferredCount };
}

export async function reconcileCloudRunCancellation(
  jobId: string,
  environment: CloudRunReconciliationEnvironment,
  _logger: StructuredLogger,
  dependencies: CloudRunReconciliationDependencies = {},
): Promise<CloudRunCancellationResult> {
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) {
    return { appliedCount: 0, deferredCount: 0, outcome: "ignored" };
  }
  const now = dependencies.now ?? (() => new Date());
  const repositoryFactory = dependencies.createRepository ?? createD1CloudRunControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const candidate = await repository.findCancellationCandidate(jobId);
  if (candidate === undefined) {
    return { appliedCount: 0, deferredCount: 0, outcome: "ignored" };
  }
  const selectedController =
    dependencies.createController?.(environment, now) ?? createController(environment, now);
  if (selectedController === undefined) {
    throw new Error("Cloud Run cancellation configuration is invalid");
  }
  const result = await applyControllerAction(
    candidate,
    "cancel",
    config.appEnvironment,
    selectedController,
    repository,
    now,
    dependencies.randomBytes ?? randomBytes,
  );
  return {
    ...result,
    outcome: result.deferredCount > 0 ? "deferred" : "applied",
  };
}

export async function reconcileCloudRunJobs(
  environment: CloudRunReconciliationEnvironment,
  logger: StructuredLogger,
  dependencies: CloudRunReconciliationDependencies = {},
): Promise<CloudRunReconciliationResult> {
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) {
    return {
      appliedCount: 0,
      deferredCount: 0,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    };
  }
  const now = dependencies.now ?? (() => new Date());
  const repositoryFactory = dependencies.createRepository ?? createD1CloudRunControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const candidates = await repository.findReconciliationCandidates(BATCH_SIZE);
  const bytes = dependencies.randomBytes ?? randomBytes;
  let appliedCount = 0;
  let deferredCount = 0;
  let failedMissingTerminalCount = 0;
  const selectedController =
    candidates.length === 0
      ? undefined
      : (dependencies.createController?.(environment, now) ?? createController(environment, now));
  if (candidates.length > 0 && selectedController === undefined) {
    throw new Error("Cloud Run reconciliation configuration is invalid");
  }
  for (const candidate of candidates) {
    if (selectedController === undefined) {
      throw new Error("Cloud Run reconciliation configuration is invalid");
    }
    if (
      candidate.executionStatus === "TERMINAL" &&
      candidate.cleanupStatus === "NOT_REQUESTED" &&
      !candidate.jobDeleted &&
      ["SUBMITTING", "RUNNING", "CANCEL_REQUESTED"].includes(candidate.jobStatus)
    ) {
      if (
        Date.parse(candidate.executionUpdatedAt) + MISSING_RUNTIME_TERMINAL_GRACE_MS >
        now().getTime()
      ) {
        deferredCount += 1;
        continue;
      }
      const failed = await repository.failMissingTerminal({
        candidate,
        timestamp: now().toISOString(),
      });
      failedMissingTerminalCount += failed ? 1 : 0;
      deferredCount += failed ? 0 : 1;
      continue;
    }
    const result = await applyControllerAction(
      candidate,
      action(candidate),
      config.appEnvironment,
      selectedController,
      repository,
      now,
      bytes,
    );
    appliedCount += result.appliedCount;
    deferredCount += result.deferredCount;
  }
  const selectedProvider = parseGpuExecutionSelection(environment);
  const pendingJobId =
    parseGpuExecutionAdmission(environment) === "active" &&
    selectedProvider?.kind === "cloud_run_jobs"
      ? await repository.findDispatchablePendingJobId()
      : undefined;
  let dispatch: SubmissionDispatchResult | "none" = "none";
  if (pendingJobId !== undefined) {
    const submit =
      dependencies.submitPendingJob ??
      ((jobId, submissionEnvironment, submissionLogger) =>
        submitPendingCloudRunJob(jobId, submissionEnvironment, { logger: submissionLogger }));
    dispatch = await submit(pendingJobId, environment, logger);
  }
  return { appliedCount, deferredCount, dispatch, failedMissingTerminalCount };
}
