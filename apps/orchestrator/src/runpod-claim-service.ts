import {
  RUNPOD_JOB_TTL_MS,
  runpodClaimResponseSchema,
  type RunpodClaimRequest,
  type RunpodClaimResponse,
  type RunpodHeartbeatRequest,
  type RunpodHeartbeatResponse,
} from "@scribe-drop/contracts";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";

import {
  createCapabilityToken,
  hashCapabilityToken,
  timingSafeHashEqual,
  type CapabilityRandomBytes,
} from "./capability-token.js";
import { createR2CapabilityIssuer, type R2CapabilityIssuer } from "./r2-capability-issuer.js";
import {
  createD1RunpodControlRepository,
  type ClaimContext,
  type RunpodControlRepository,
} from "./runpod-control-repository.js";
import {
  createRunpodPlacementVerifier,
  type RunpodPlacementVerifier,
} from "./runpod-placement-verifier.js";

export const HEARTBEAT_TOKEN_TTL_MS = RUNPOD_JOB_TTL_MS;

export type ClaimServiceResult =
  | {
      readonly kind: "granted";
      readonly response: Extract<RunpodClaimResponse, { readonly granted: true }>;
    }
  | {
      readonly kind: "deduplicated";
      readonly response: Extract<RunpodClaimResponse, { readonly deduplicated: true }>;
    }
  | {
      readonly kind: "rejected";
    };

export type HeartbeatServiceResult =
  | {
      readonly kind: "accepted";
      readonly response: RunpodHeartbeatResponse;
    }
  | {
      readonly kind: "rejected";
    };

export interface RunpodClaimEnvironment {
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly RUNPOD_ALLOWED_GPU_IDS: string;
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly RUNPOD_INTERNAL_BASE_URL: string;
  readonly RUNPOD_WORKER_IMAGE: string;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface RunpodClaimDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createR2CapabilityIssuer?: (environment: RunpodClaimEnvironment) => R2CapabilityIssuer;
  readonly createRepository?: (database: D1Database) => RunpodControlRepository;
  readonly createRunpodPlacementVerifier?: (
    environment: RunpodClaimEnvironment,
  ) => RunpodPlacementVerifier;
  readonly logger: StructuredLogger;
  readonly now?: () => Date;
  readonly randomBytes?: CapabilityRandomBytes & RandomBytes;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function claimContextAllowsAuthentication(
  context: ClaimContext | undefined,
  observedHash: string,
  now: Date,
): context is ClaimContext {
  const expectedHash = context?.claimTokenHash ?? "0".repeat(64);
  const hashMatches = timingSafeHashEqual(expectedHash, observedHash);
  return (
    context !== undefined &&
    hashMatches &&
    context.activeAttemptId === context.attemptId &&
    new Date(context.claimExpiresAt).getTime() > now.getTime()
  );
}

function isActiveWinnerContext(context: ClaimContext): boolean {
  return (
    context.claimConsumedAt !== null &&
    context.winningRunpodJobId !== null &&
    context.attemptStatus === "RUNNING" &&
    context.jobStatus === "RUNNING"
  );
}

export async function claimRunpodExecution(
  request: RunpodClaimRequest,
  environment: RunpodClaimEnvironment,
  dependencies: RunpodClaimDependencies,
): Promise<ClaimServiceResult> {
  const now = dependencies.now?.() ?? new Date();
  const repositoryFactory = dependencies.createRepository ?? createD1RunpodControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const observedHash = await hashCapabilityToken(request.claimToken);
  const context = await repository.findClaimContext(request.attemptId, request.jobId);

  if (!claimContextAllowsAuthentication(context, observedHash, now)) {
    dependencies.logger.warn("runpod_claim_rejected", {
      attemptId: request.attemptId,
      errorCode: "CLAIM_REJECTED",
      jobId: request.jobId,
    });
    return { kind: "rejected" };
  }

  if (context.claimConsumedAt !== null || context.winningRunpodJobId !== null) {
    if (isActiveWinnerContext(context) && context.winningRunpodJobId !== request.runpodJobId) {
      await repository.recordClaimSubmission({
        attemptId: request.attemptId,
        runpodJobId: request.runpodJobId,
        timestamp: now.toISOString(),
      });
      dependencies.logger.info("runpod_claim_deduplicated", {
        attemptId: request.attemptId,
        jobId: request.jobId,
        runpodJobId: request.runpodJobId,
      });
      return {
        kind: "deduplicated",
        response: { deduplicated: true },
      };
    }
    dependencies.logger.warn("runpod_claim_rejected", {
      attemptId: request.attemptId,
      errorCode: "CLAIM_REJECTED",
      jobId: request.jobId,
      runpodJobId: request.runpodJobId,
    });
    return { kind: "rejected" };
  }

  if (context.attemptStatus !== "SUBMITTING" || context.jobStatus !== "SUBMITTING") {
    dependencies.logger.warn("runpod_claim_rejected", {
      attemptId: request.attemptId,
      errorCode: "CLAIM_REJECTED",
      jobId: request.jobId,
    });
    return { kind: "rejected" };
  }

  const placementVerifierFactory =
    dependencies.createRunpodPlacementVerifier ??
    ((verifierEnvironment: RunpodClaimEnvironment) =>
      createRunpodPlacementVerifier({
        allowedGpuTypeIds: verifierEnvironment.RUNPOD_ALLOWED_GPU_IDS.split(",").map((value) =>
          value.trim(),
        ),
        apiKey: verifierEnvironment.RUNPOD_API_KEY,
        endpointId: verifierEnvironment.RUNPOD_ENDPOINT_ID,
        expectedImage: verifierEnvironment.RUNPOD_WORKER_IMAGE,
      }));
  const placement = await placementVerifierFactory(environment).verify(request.runpodJobId);
  if (placement.outcome !== "verified") {
    dependencies.logger.warn("runpod_claim_rejected", {
      attemptId: request.attemptId,
      errorCode: "CLAIM_REJECTED",
      jobId: request.jobId,
    });
    return { kind: "rejected" };
  }

  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes;
  const heartbeat = await createCapabilityToken(randomBytes);
  const heartbeatExpiresAt = new Date(now.getTime() + HEARTBEAT_TOKEN_TTL_MS).toISOString();
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) => createUlid(timestampMilliseconds, randomBytes));
  const won = await repository.claimWinner({
    attemptId: request.attemptId,
    claimTokenHash: observedHash,
    eventId: createEventId(now.getTime()),
    heartbeatExpiresAt,
    heartbeatTokenHash: heartbeat.hash,
    jobId: request.jobId,
    runpodJobId: request.runpodJobId,
    timestamp: now.toISOString(),
  });

  if (!won) {
    const current = await repository.findClaimContext(request.attemptId, request.jobId);
    if (
      claimContextAllowsAuthentication(current, observedHash, now) &&
      isActiveWinnerContext(current) &&
      current.winningRunpodJobId !== request.runpodJobId
    ) {
      dependencies.logger.info("runpod_claim_deduplicated", {
        attemptId: request.attemptId,
        jobId: request.jobId,
        runpodJobId: request.runpodJobId,
      });
      return {
        kind: "deduplicated",
        response: { deduplicated: true },
      };
    }
    dependencies.logger.warn("runpod_claim_rejected", {
      attemptId: request.attemptId,
      errorCode: "CLAIM_REJECTED",
      jobId: request.jobId,
      runpodJobId: request.runpodJobId,
    });
    return { kind: "rejected" };
  }

  const issuerFactory =
    dependencies.createR2CapabilityIssuer ??
    ((issuerEnvironment: RunpodClaimEnvironment) =>
      createR2CapabilityIssuer({
        accessKeyId: issuerEnvironment.R2_ACCESS_KEY_ID,
        accountId: issuerEnvironment.CLOUDFLARE_ACCOUNT_ID,
        secretAccessKey: issuerEnvironment.R2_SECRET_ACCESS_KEY,
      }));
  const capabilities = await issuerFactory(environment).issue({
    resultPrefix: context.resultPrefix,
    sourceBucket: context.sourceBucket,
    sourceKey: context.sourceKey,
  });
  const response = runpodClaimResponseSchema.parse({
    expiresAt: capabilities.expiresAt,
    granted: true,
    heartbeat: {
      token: heartbeat.raw,
      url: new URL("/internal/runpod/heartbeat", environment.RUNPOD_INTERNAL_BASE_URL).toString(),
    },
    results: {
      jsonPutUrl: capabilities.jsonPutUrl,
      manifestPutUrl: capabilities.manifestPutUrl,
      markdownPutUrl: capabilities.markdownPutUrl,
      srtPutUrl: capabilities.srtPutUrl,
    },
    source: {
      expectedEtag: context.sourceEtag,
      expectedSizeBytes: context.actualSizeBytes,
      getUrl: capabilities.sourceGetUrl,
    },
  });
  if (!("granted" in response)) {
    throw new Error("Granted claim response failed validation");
  }
  dependencies.logger.info("runpod_claim_granted", {
    attemptId: request.attemptId,
    jobId: request.jobId,
    runpodJobId: request.runpodJobId,
    status: "RUNNING",
  });
  return {
    kind: "granted",
    response,
  };
}

export async function recordRunpodHeartbeat(
  request: RunpodHeartbeatRequest,
  environment: Pick<RunpodClaimEnvironment, "SCRIBE_DROP_DB">,
  dependencies: Pick<RunpodClaimDependencies, "createRepository" | "logger" | "now">,
): Promise<HeartbeatServiceResult> {
  const now = dependencies.now?.() ?? new Date();
  const repositoryFactory = dependencies.createRepository ?? createD1RunpodControlRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const observedHash = await hashCapabilityToken(request.heartbeatToken);
  const context = await repository.findClaimContext(request.attemptId, request.jobId);
  const expectedHash = context?.heartbeatTokenHash ?? "0".repeat(64);
  const accepted =
    context !== undefined &&
    timingSafeHashEqual(expectedHash, observedHash) &&
    context.activeAttemptId === context.attemptId &&
    context.winningRunpodJobId === request.runpodJobId &&
    context.heartbeatIssuedAt !== null &&
    context.heartbeatExpiresAt !== null &&
    new Date(context.heartbeatExpiresAt).getTime() > now.getTime() &&
    context.heartbeatRevokedAt === null &&
    (context.attemptStatus === "RUNNING" || context.attemptStatus === "CANCEL_REQUESTED") &&
    (context.jobStatus === "RUNNING" || context.jobStatus === "CANCEL_REQUESTED") &&
    (await repository.markHeartbeat({
      attemptId: request.attemptId,
      heartbeatTokenHash: observedHash,
      jobId: request.jobId,
      runpodJobId: request.runpodJobId,
      timestamp: now.toISOString(),
    }));

  if (!accepted) {
    dependencies.logger.warn("runpod_heartbeat_rejected", {
      attemptId: request.attemptId,
      errorCode: "HEARTBEAT_REJECTED",
      jobId: request.jobId,
      runpodJobId: request.runpodJobId,
    });
    return { kind: "rejected" };
  }
  dependencies.logger.info("runpod_heartbeat_accepted", {
    attemptId: request.attemptId,
    jobId: request.jobId,
    runpodJobId: request.runpodJobId,
  });
  return {
    kind: "accepted",
    response: {
      cancelRequested:
        context.attemptStatus === "CANCEL_REQUESTED" || context.jobStatus === "CANCEL_REQUESTED",
    },
  };
}
