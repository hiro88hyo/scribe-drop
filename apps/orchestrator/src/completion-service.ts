import {
  RUNPOD_EXECUTION_TIMEOUT_MS,
  RUNPOD_JOB_TTL_MS,
  resultManifestSchema,
  type ResultManifest,
  type RunpodStatusResponse,
} from "@scribe-drop/contracts";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";
import { z } from "zod";

import {
  createD1CompletionRepository,
  type CompletionRepository,
  type TerminalOutcome,
  type VerifiedArtifact,
} from "./completion-repository.js";
import { createRunpodClient, type RunpodControlClient } from "./runpod-client.js";

const RECONCILIATION_BATCH_SIZE = 25;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HEARTBEAT_STALE_MS = 10 * 60 * 1_000;
const EXECUTION_DEADLINE_GRACE_MS = 15 * 60 * 1_000;
const RESULT_RETENTION_GRACE_MS = 30 * 60 * 1_000;
const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const r2HeadSchema = z.object({
  size: z.number().int().min(0).max(2_147_483_648),
});

export interface CompletionEnvironment {
  readonly RECORDINGS: R2Bucket;
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface CompletionDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createNotificationId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: D1Database) => CompletionRepository;
  readonly createRunpodClient?: (environment: CompletionEnvironment) => RunpodControlClient;
  readonly headArtifact?: (bucket: R2Bucket, key: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly readManifest?: (bucket: R2Bucket, key: string) => Promise<unknown>;
}

export interface CompletionResult {
  readonly cancelledCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly terminalObservedCount: number;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function hasMatchingOutputIdentity(
  response: RunpodStatusResponse,
  jobId: string,
  attemptId: string,
): boolean {
  return (
    response.output === undefined ||
    (response.output.jobId === jobId && response.output.attemptId === attemptId)
  );
}

async function defaultReadManifest(bucket: R2Bucket, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }
  if (object.size > MAX_MANIFEST_BYTES) {
    throw new Error("Result manifest exceeds the size limit");
  }
  const text = await object.text();
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("Result manifest is empty or exceeds the size limit");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error("Result manifest is not valid JSON");
  }
}

function manifestArtifacts(
  manifest: ResultManifest,
  resultPrefix: string,
): readonly [VerifiedArtifact, VerifiedArtifact, VerifiedArtifact] | undefined {
  const entries = [
    {
      format: "markdown",
      key: `${resultPrefix}transcript.md`,
      manifest: manifest.artifacts.markdown,
    },
    {
      format: "json",
      key: `${resultPrefix}transcript.json`,
      manifest: manifest.artifacts.json,
    },
    {
      format: "srt",
      key: `${resultPrefix}transcript.srt`,
      manifest: manifest.artifacts.srt,
    },
  ] as const;
  if (entries.some((entry) => entry.manifest.key !== entry.key)) {
    return undefined;
  }
  return entries.map((entry) => ({
    format: entry.format,
    key: entry.key,
    sha256: entry.manifest.sha256,
    sizeBytes: entry.manifest.sizeBytes,
  })) as [VerifiedArtifact, VerifiedArtifact, VerifiedArtifact];
}

async function verifyArtifacts(
  outcome: TerminalOutcome,
  environment: CompletionEnvironment,
  dependencies: CompletionDependencies,
): Promise<readonly [VerifiedArtifact, VerifiedArtifact, VerifiedArtifact] | undefined> {
  const readManifest = dependencies.readManifest ?? defaultReadManifest;
  const untrustedManifest = await readManifest(
    environment.RECORDINGS,
    `${outcome.resultPrefix}manifest.json`,
  );
  const manifestResult = resultManifestSchema.safeParse(untrustedManifest);
  if (
    !manifestResult.success ||
    manifestResult.data.jobId !== outcome.jobId ||
    manifestResult.data.attemptId !== outcome.attemptId
  ) {
    return undefined;
  }
  const artifacts = manifestArtifacts(manifestResult.data, outcome.resultPrefix);
  if (artifacts === undefined) {
    return undefined;
  }
  const headArtifact =
    dependencies.headArtifact ?? ((bucket: R2Bucket, key: string) => bucket.head(key));
  const heads = await Promise.all(
    artifacts.map((artifact) => headArtifact(environment.RECORDINGS, artifact.key)),
  );
  for (const [index, untrustedHead] of heads.entries()) {
    if (untrustedHead === null) {
      return undefined;
    }
    const head = r2HeadSchema.safeParse(untrustedHead);
    if (!head.success || head.data.size !== artifacts[index]?.sizeBytes) {
      return undefined;
    }
  }
  return artifacts;
}

function isCompletionOutcome(outcome: TerminalOutcome): boolean {
  return (
    outcome.runpodTerminalStatus === "COMPLETED" &&
    outcome.runpodOutputStatus === "completed" &&
    outcome.runpodManifestWritten === true &&
    outcome.durationSeconds !== null &&
    outcome.winningRunpodJobId === outcome.runpodTerminalJobId
  );
}

export async function reconcileRunpodCompletions(
  environment: CompletionEnvironment,
  logger: StructuredLogger,
  dependencies: CompletionDependencies = {},
): Promise<CompletionResult> {
  const now = dependencies.now ?? (() => new Date());
  const repositoryFactory = dependencies.createRepository ?? createD1CompletionRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const clientFactory =
    dependencies.createRunpodClient ??
    ((clientEnvironment: CompletionEnvironment) =>
      createRunpodClient({
        apiKey: clientEnvironment.RUNPOD_API_KEY,
        endpointId: clientEnvironment.RUNPOD_ENDPOINT_ID,
      }));
  const client = clientFactory(environment);
  let terminalObservedCount = 0;
  let failedCount = 0;
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));

  for (const candidate of await repository.findStatusPollCandidates(RECONCILIATION_BATCH_SIZE)) {
    const observedAt = now();
    const heartbeatBaseline = candidate.heartbeatAt ?? candidate.claimedAt;
    if (
      heartbeatBaseline !== null &&
      Date.parse(heartbeatBaseline) <= observedAt.getTime() - HEARTBEAT_STALE_MS
    ) {
      logger.warn("runpod_heartbeat_stale", {
        attemptId: candidate.attemptId,
        errorCode: "INTERNAL_ERROR",
        jobId: candidate.jobId,
        runpodJobId: candidate.runpodJobId,
      });
    }
    if (candidate.jobStatus === "CANCEL_REQUESTED") {
      await client.cancel(candidate.runpodJobId);
    }
    const result = await client.getStatus(candidate.runpodJobId);
    if (result.outcome !== "found") {
      if (
        result.outcome === "not_found" &&
        Date.parse(candidate.submissionStartedAt) <=
          observedAt.getTime() - RUNPOD_JOB_TTL_MS - RESULT_RETENTION_GRACE_MS
      ) {
        const failed = await repository.failUnobservableAttempt({
          attemptId: candidate.attemptId,
          cutoff: new Date(
            observedAt.getTime() - RUNPOD_JOB_TTL_MS - RESULT_RETENTION_GRACE_MS,
          ).toISOString(),
          deadline: "submission",
          eventId: createEventId(observedAt.getTime()),
          jobId: candidate.jobId,
          runpodJobId: candidate.runpodJobId,
          timestamp: observedAt.toISOString(),
        });
        if (failed) {
          failedCount += 1;
          logger.warn("job.failed", {
            attemptId: candidate.attemptId,
            errorCode: "PROCESSING_FAILED",
            jobId: candidate.jobId,
            status: "FAILED",
          });
        }
      }
      logger.warn(
        result.outcome === "invalid_response"
          ? "runpod_status_invalid"
          : "runpod_status_unavailable",
        {
          attemptId: candidate.attemptId,
          errorCode: "INTERNAL_ERROR",
          jobId: candidate.jobId,
          runpodJobId: candidate.runpodJobId,
        },
      );
      continue;
    }
    const response = result.response;
    if (
      response.id !== candidate.runpodJobId ||
      !hasMatchingOutputIdentity(response, candidate.jobId, candidate.attemptId)
    ) {
      logger.warn("runpod_status_invalid", {
        attemptId: candidate.attemptId,
        errorCode: "INTERNAL_ERROR",
        jobId: candidate.jobId,
        runpodJobId: candidate.runpodJobId,
      });
      continue;
    }
    if (!terminalStatuses.has(response.status)) {
      if (
        candidate.claimedAt !== null &&
        Date.parse(candidate.claimedAt) <=
          observedAt.getTime() - RUNPOD_EXECUTION_TIMEOUT_MS - EXECUTION_DEADLINE_GRACE_MS
      ) {
        await client.cancel(candidate.runpodJobId);
        const failed = await repository.failUnobservableAttempt({
          attemptId: candidate.attemptId,
          cutoff: new Date(
            observedAt.getTime() - RUNPOD_EXECUTION_TIMEOUT_MS - EXECUTION_DEADLINE_GRACE_MS,
          ).toISOString(),
          deadline: "execution",
          eventId: createEventId(observedAt.getTime()),
          jobId: candidate.jobId,
          runpodJobId: candidate.runpodJobId,
          timestamp: observedAt.toISOString(),
        });
        if (failed) {
          failedCount += 1;
          logger.warn("job.failed", {
            attemptId: candidate.attemptId,
            errorCode: "PROCESSING_FAILED",
            jobId: candidate.jobId,
            status: "FAILED",
          });
        }
      }
      continue;
    }
    const recorded = await repository.recordTerminalStatus({
      attemptId: candidate.attemptId,
      delayTime: response.delayTime ?? null,
      executionTime: response.executionTime ?? null,
      jobId: candidate.jobId,
      output: response.output ?? null,
      runpodJobId: candidate.runpodJobId,
      status: response.status,
      timestamp: now().toISOString(),
    });
    if (recorded) {
      terminalObservedCount += 1;
      logger.info("runpod_terminal_observed", {
        attemptId: candidate.attemptId,
        jobId: candidate.jobId,
        runpodJobId: candidate.runpodJobId,
        status: response.status,
      });
    }
  }

  const createNotificationId =
    dependencies.createNotificationId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
  let cancelledCount = 0;
  let completedCount = 0;

  for (const outcome of await repository.findTerminalOutcomes(RECONCILIATION_BATCH_SIZE)) {
    const timestamp = now();
    if (isCompletionOutcome(outcome)) {
      let artifacts: readonly [VerifiedArtifact, VerifiedArtifact, VerifiedArtifact] | undefined;
      try {
        artifacts = await verifyArtifacts(outcome, environment, dependencies);
      } catch {
        artifacts = undefined;
      }
      if (artifacts === undefined || outcome.durationSeconds === null) {
        if (
          Date.parse(outcome.runpodTerminalObservedAt) <=
          timestamp.getTime() - RESULT_RETENTION_GRACE_MS
        ) {
          const failed = await repository.finalizeTerminal({
            attemptId: outcome.attemptId,
            errorCode: "PROCESSING_FAILED",
            jobId: outcome.jobId,
            runpodJobId: outcome.runpodTerminalJobId,
            status: "FAILED",
            timestamp: timestamp.toISOString(),
          });
          if (failed) {
            failedCount += 1;
            logger.warn("job.failed", {
              attemptId: outcome.attemptId,
              errorCode: "PROCESSING_FAILED",
              jobId: outcome.jobId,
              status: "FAILED",
            });
          }
          continue;
        }
        logger.warn("job.completion_deferred", {
          attemptId: outcome.attemptId,
          errorCode: "ARTIFACT_NOT_READY",
          jobId: outcome.jobId,
          runpodJobId: outcome.runpodTerminalJobId,
        });
        continue;
      }
      const completed = await repository.finalizeCompleted({
        artifacts,
        attemptId: outcome.attemptId,
        durationSeconds: outcome.durationSeconds,
        eventId: createEventId(timestamp.getTime()),
        jobId: outcome.jobId,
        notificationId: createNotificationId(timestamp.getTime()),
        runpodJobId: outcome.runpodTerminalJobId,
        timestamp: timestamp.toISOString(),
      });
      if (completed) {
        completedCount += 1;
        logger.info("job.completed", {
          attemptId: outcome.attemptId,
          jobId: outcome.jobId,
          runpodJobId: outcome.runpodTerminalJobId,
          status: "COMPLETED",
        });
      }
      continue;
    }

    const cancelled =
      outcome.runpodTerminalStatus === "CANCELLED" || outcome.runpodOutputStatus === "cancelled";
    const finalized = await repository.finalizeTerminal({
      attemptId: outcome.attemptId,
      errorCode: cancelled ? null : "PROCESSING_FAILED",
      jobId: outcome.jobId,
      runpodJobId: outcome.runpodTerminalJobId,
      status: cancelled ? "CANCELLED" : "FAILED",
      timestamp: timestamp.toISOString(),
    });
    if (finalized) {
      if (cancelled) {
        cancelledCount += 1;
        logger.info("job.cancelled", {
          attemptId: outcome.attemptId,
          jobId: outcome.jobId,
          status: "CANCELLED",
        });
      } else {
        failedCount += 1;
        logger.warn("job.failed", {
          attemptId: outcome.attemptId,
          errorCode: "PROCESSING_FAILED",
          jobId: outcome.jobId,
          status: "FAILED",
        });
      }
    }
  }

  return {
    cancelledCount,
    completedCount,
    failedCount,
    terminalObservedCount,
  };
}
