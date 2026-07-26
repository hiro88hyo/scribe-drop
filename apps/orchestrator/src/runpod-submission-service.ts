import {
  RUNPOD_EXECUTION_TIMEOUT_MS,
  RUNPOD_JOB_TTL_MS,
  runpodRunRequestSchema,
} from "@scribe-drop/contracts";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";

import { createCapabilityToken, type CapabilityRandomBytes } from "./capability-token.js";
import {
  createD1RunpodControlRepository,
  type RunpodControlRepository,
} from "./runpod-control-repository.js";
import { createRunpodClient, type RunpodSubmissionClient } from "./runpod-client.js";

export const CLAIM_TOKEN_TTL_MS = 15 * 60 * 1_000;

export type SubmissionDispatchResult = "accepted" | "deferred" | "rejected" | "unknown";

export interface RunpodSubmissionEnvironment {
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface RunpodSubmissionDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: D1Database) => RunpodControlRepository;
  readonly createRunpodClient?: (
    environment: RunpodSubmissionEnvironment,
  ) => RunpodSubmissionClient;
  readonly logger: StructuredLogger;
  readonly now?: () => Date;
  readonly randomBytes?: CapabilityRandomBytes & RandomBytes;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function submitPendingRunpodJob(
  jobId: string,
  environment: RunpodSubmissionEnvironment,
  dependencies: RunpodSubmissionDependencies,
): Promise<SubmissionDispatchResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const timestamp = startedAt.toISOString();
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes;
  const claim = await createCapabilityToken(randomBytes);
  const repositoryFactory = dependencies.createRepository ?? createD1RunpodControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const prepared = await repository.prepareSubmission({
    claimExpiresAt: new Date(startedAt.getTime() + CLAIM_TOKEN_TTL_MS).toISOString(),
    claimTokenHash: claim.hash,
    jobId,
    timestamp,
  });
  if (prepared === undefined) {
    dependencies.logger.info("job.submission_deferred", {
      jobId,
      status: "SUBMISSION_PENDING",
    });
    return "deferred";
  }

  dependencies.logger.info("job.submission_started", {
    attemptId: prepared.attemptId,
    jobId: prepared.jobId,
    status: "SUBMITTING",
  });
  const request = runpodRunRequestSchema.parse({
    input: {
      attemptId: prepared.attemptId,
      claimToken: claim.raw,
      jobId: prepared.jobId,
      schemaVersion: 1,
    },
    policy: {
      executionTimeout: RUNPOD_EXECUTION_TIMEOUT_MS,
      ttl: RUNPOD_JOB_TTL_MS,
    },
  });
  const clientFactory =
    dependencies.createRunpodClient ??
    ((clientEnvironment: RunpodSubmissionEnvironment) =>
      createRunpodClient({
        apiKey: clientEnvironment.RUNPOD_API_KEY,
        endpointId: clientEnvironment.RUNPOD_ENDPOINT_ID,
      }));
  const result = await clientFactory(environment).submit(request);
  const finishedAt = now();
  const finishedTimestamp = finishedAt.toISOString();

  if (result.outcome === "accepted") {
    const recorded = await repository.recordSubmissionAccepted({
      attemptId: prepared.attemptId,
      runpodJobId: result.runpodJobId,
      timestamp: finishedTimestamp,
    });
    if (recorded) {
      dependencies.logger.info("job.submission_accepted", {
        attemptId: prepared.attemptId,
        jobId: prepared.jobId,
        runpodJobId: result.runpodJobId,
        status: "SUBMITTING",
      });
      return "accepted";
    }
    const markedUnknown = await repository.recordSubmissionUnknown(
      prepared.attemptId,
      finishedTimestamp,
    );
    if (!markedUnknown) {
      throw new Error("Submission outcome could not be persisted");
    }
    dependencies.logger.warn("job.submission_unknown", {
      attemptId: prepared.attemptId,
      errorCode: "INTERNAL_ERROR",
      jobId: prepared.jobId,
      status: "SUBMITTING",
    });
    return "unknown";
  }

  if (result.outcome === "unknown") {
    const recorded = await repository.recordSubmissionUnknown(
      prepared.attemptId,
      finishedTimestamp,
    );
    if (!recorded) {
      throw new Error("Submission outcome could not be persisted");
    }
    dependencies.logger.warn("job.submission_unknown", {
      attemptId: prepared.attemptId,
      errorCode: "INTERNAL_ERROR",
      jobId: prepared.jobId,
      status: "SUBMITTING",
    });
    return "unknown";
  }

  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) => createUlid(timestampMilliseconds, randomBytes));
  const recorded = await repository.recordSubmissionRejected({
    attemptId: prepared.attemptId,
    eventId: createEventId(finishedAt.getTime()),
    jobId: prepared.jobId,
    timestamp: finishedTimestamp,
  });
  if (!recorded) {
    throw new Error("Submission outcome could not be persisted");
  }
  dependencies.logger.warn("job.submission_rejected", {
    attemptId: prepared.attemptId,
    errorCode: "PROCESSING_FAILED",
    jobId: prepared.jobId,
    status: "FAILED",
  });
  return "rejected";
}
