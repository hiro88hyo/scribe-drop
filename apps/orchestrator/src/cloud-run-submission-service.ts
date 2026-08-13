import {
  CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS,
  CLOUD_RUN_RUNTIME_POLICY,
  cloudRunControllerRequestSchema,
  type CloudRunControllerRequest,
  type CloudRunControllerResponse,
} from "@scribe-drop/contracts";
import { createUlid } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";

import {
  CloudRunControllerClient,
  type CloudRunControllerClientPorts,
} from "./cloud-run-controller-client.js";
import {
  createD1CloudRunControlRepository,
  type CloudRunControlRepository,
} from "./cloud-run-control-repository.js";
import {
  decodeCloudRunRuntimeSecret,
  parseCloudRunRuntimeServiceConfig,
  type CloudRunRuntimeServiceConfigEnvironment,
} from "./config.js";
import type { SubmissionDispatchResult } from "./runpod-submission-service.js";

const CONTROLLER_REQUEST_LIFETIME_MS = 30_000;
const SAFE_PRE_ADMISSION_REJECTIONS = new Set([
  "BUDGET_EXHAUSTED",
  "ENVIRONMENT_MISMATCH",
  "RATE_LIMITED",
]);
const encoder = new TextEncoder();

export interface CloudRunSubmissionEnvironment extends CloudRunRuntimeServiceConfigEnvironment {
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface CloudRunSubmissionController {
  mutate(request: CloudRunControllerRequest): Promise<CloudRunControllerResponse>;
}

export interface CloudRunSubmissionDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createController?: (
    environment: CloudRunSubmissionEnvironment,
  ) => CloudRunSubmissionController;
  readonly createRepository?: (database: D1Database) => CloudRunControlRepository;
  readonly logger: StructuredLogger;
  readonly now?: () => Date;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function deriveCloudRunExecutionHandle(attemptId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`scribe-drop-cloud-run-execution-v1:${attemptId}`),
  );
  return base64Url(new Uint8Array(digest));
}

function controller(
  environment: CloudRunSubmissionEnvironment,
  now: () => Date,
): CloudRunControllerClient | undefined {
  const config = parseCloudRunRuntimeServiceConfig(environment);
  if (config === undefined) return undefined;
  const secret = decodeCloudRunRuntimeSecret(config.controllerHmacPrimary);
  if (secret === undefined) return undefined;
  const ports: CloudRunControllerClientPorts = {
    clock: { now },
    fetch,
    ids: {
      next: () => {
        throw new Error("Cloud Run submission supplies persisted request IDs");
      },
    },
  };
  return new CloudRunControllerClient(
    {
      baseUrl: config.controllerOrigin,
      environment: config.appEnvironment,
      keyId: "primary",
      requestLifetimeMs: CONTROLLER_REQUEST_LIFETIME_MS,
      secret,
    },
    ports,
  );
}

export async function submitPendingCloudRunJob(
  jobId: string,
  environment: CloudRunSubmissionEnvironment,
  dependencies: CloudRunSubmissionDependencies,
): Promise<SubmissionDispatchResult> {
  const now = dependencies.now ?? (() => new Date());
  const repositoryFactory = dependencies.createRepository ?? createD1CloudRunControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const candidate = await repository.findSubmissionCandidate(jobId);
  if (candidate === undefined) return "deferred";
  const executionHandle = await deriveCloudRunExecutionHandle(candidate.attemptId);
  const startedAt = now();
  const prepared = await repository.prepareSubmission({
    candidate,
    executionHandle,
    timestamp: startedAt.toISOString(),
  });
  if (prepared === undefined) return "deferred";
  const config = parseCloudRunRuntimeServiceConfig(environment);
  const selectedController =
    dependencies.createController?.(environment) ?? controller(environment, now);
  if (config === undefined || selectedController === undefined) {
    throw new Error("Cloud Run submission configuration is invalid");
  }
  const request = cloudRunControllerRequestSchema.parse({
    action: "create",
    environment: config.appEnvironment,
    executionHandle: prepared.executionHandle,
    expectedVersion: 0,
    expiresAt: new Date(
      startedAt.getTime() +
        Math.min(CONTROLLER_REQUEST_LIFETIME_MS, CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS),
    ).toISOString(),
    issuedAt: prepared.submissionStartedAt,
    policyId: CLOUD_RUN_RUNTIME_POLICY,
    requestId: prepared.attemptId,
    schemaVersion: 1,
  });
  dependencies.logger.info("job.submission_started", {
    attemptId: prepared.attemptId,
    jobId: prepared.jobId,
    status: "SUBMITTING",
  });

  let response: CloudRunControllerResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await selectedController.mutate(request);
      break;
    } catch {
      // The exact signed request is replay-safe while its bounded lifetime remains valid.
    }
  }
  const finishedAt = now().toISOString();
  if (response === undefined) {
    if (
      !(await repository.recordCreateUnknown({
        attemptId: prepared.attemptId,
        executionHandle: prepared.executionHandle,
        jobId: prepared.jobId,
        timestamp: finishedAt,
      }))
    ) {
      throw new Error("Cloud Run unknown outcome could not be persisted");
    }
    dependencies.logger.warn("job.submission_unknown", {
      attemptId: prepared.attemptId,
      errorCode: "INTERNAL_ERROR",
      jobId: prepared.jobId,
      status: "SUBMITTING",
    });
    return "unknown";
  }
  if (
    response.outcome === "rejected" &&
    response.errorCode !== null &&
    SAFE_PRE_ADMISSION_REJECTIONS.has(response.errorCode)
  ) {
    const createEventId =
      dependencies.createEventId ??
      ((timestampMilliseconds: number) =>
        createUlid(timestampMilliseconds, (length) =>
          crypto.getRandomValues(new Uint8Array(length)),
        ));
    if (
      !(await repository.recordCreateRejected({
        attemptId: prepared.attemptId,
        eventId: createEventId(new Date(finishedAt).getTime()),
        executionHandle: prepared.executionHandle,
        jobId: prepared.jobId,
        response,
        timestamp: finishedAt,
      }))
    ) {
      throw new Error("Cloud Run rejected outcome could not be persisted");
    }
    dependencies.logger.warn("job.submission_rejected", {
      attemptId: prepared.attemptId,
      errorCode: "PROCESSING_FAILED",
      jobId: prepared.jobId,
      status: "FAILED",
    });
    return "rejected";
  }
  if (response.outcome === "rejected" && response.errorCode !== null) {
    if (
      !(await repository.recordCreateResponse({
        attemptId: prepared.attemptId,
        executionHandle: prepared.executionHandle,
        jobId: prepared.jobId,
        response,
        timestamp: finishedAt,
      }))
    ) {
      throw new Error("Cloud Run uncertain rejection could not be persisted");
    }
    dependencies.logger.warn("job.submission_unknown", {
      attemptId: prepared.attemptId,
      errorCode: "INTERNAL_ERROR",
      jobId: prepared.jobId,
      status: "SUBMITTING",
    });
    return "unknown";
  }
  if (
    !["accepted", "pending", "running", "unknown"].includes(response.outcome) ||
    response.errorCode !== null
  ) {
    throw new Error("Cloud Run create returned an invalid outcome");
  }
  if (
    !(await repository.recordCreateResponse({
      attemptId: prepared.attemptId,
      executionHandle: prepared.executionHandle,
      jobId: prepared.jobId,
      response,
      timestamp: finishedAt,
    }))
  ) {
    throw new Error("Cloud Run create outcome could not be persisted");
  }
  dependencies.logger.info("job.submission_accepted", {
    attemptId: prepared.attemptId,
    jobId: prepared.jobId,
    status: response.outcome === "running" ? "RUNNING" : "SUBMITTING",
  });
  return response.outcome === "unknown" ? "unknown" : "accepted";
}
