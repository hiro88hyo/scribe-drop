import type { StructuredLogger } from "@scribe-drop/observability";
import { z } from "zod";

import {
  createD1DeletionRepository,
  type DeletionCandidate,
  type DeletionRepository,
} from "./deletion-repository.js";
import { createRunpodClient, type RunpodControlClient } from "./runpod-client.js";

const DELETION_BATCH_SIZE = 25;
const DATABASE_PAGE_SIZE = 100;
const R2_DELETE_BATCH_SIZE = 1_000;
const MAX_DATABASE_PAGES = 1_000;
const MAX_R2_DELETE_BATCHES = 10_000;
const RETRY_BASE_MILLISECONDS = 30_000;
const RETRY_MAX_MILLISECONDS = 60 * 60 * 1_000;

const r2ListResultSchema = z
  .object({
    objects: z.array(
      z.looseObject({
        key: z.string().min(1).max(1_024),
      }),
    ),
    truncated: z.boolean(),
  })
  .loose();

class R2DeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2DeletionError";
  }
}

export interface DeletionEnvironment {
  readonly RECORDINGS: R2Bucket;
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface DeletionDependencies {
  readonly createRepository?: (database: D1Database) => DeletionRepository;
  readonly createRunpodClient?: (environment: DeletionEnvironment) => RunpodControlClient;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export interface DeletionSweepResult {
  readonly completedCount: number;
  readonly deferredCount: number;
  readonly retryCount: number;
}

type DeletionErrorCode = "D1_DELETE_FAILED" | "R2_DELETE_FAILED" | "RUNPOD_CANCEL_FAILED";

function retryAt(
  timestampMilliseconds: number,
  attemptCount: number,
  random: () => number,
): string {
  const untrustedRandom = random();
  if (!Number.isFinite(untrustedRandom) || untrustedRandom < 0 || untrustedRandom >= 1) {
    throw new Error("Retry random source must return a value from zero up to one");
  }
  const exponentialDelay = Math.min(
    RETRY_MAX_MILLISECONDS,
    RETRY_BASE_MILLISECONDS * 2 ** Math.min(attemptCount, 10),
  );
  const jitteredDelay = Math.max(
    1_000,
    Math.round(exponentialDelay * (0.75 + untrustedRandom / 2)),
  );
  return new Date(timestampMilliseconds + jitteredDelay).toISOString();
}

async function recordRetry(
  repository: DeletionRepository,
  candidate: DeletionCandidate,
  errorCode: DeletionErrorCode,
  timestamp: string,
  timestampMilliseconds: number,
  random: () => number,
  logger: StructuredLogger,
): Promise<boolean> {
  const recorded = await repository.recordDeletionRetry({
    errorCode,
    expectedVersion: candidate.version,
    jobId: candidate.jobId,
    nextAttemptAt: retryAt(timestampMilliseconds, candidate.deletionAttemptCount, random),
    timestamp,
  });
  if (recorded) {
    logger.warn("job.deletion_retry", {
      errorCode,
      jobId: candidate.jobId,
    });
  }
  return recorded;
}

async function findAllRunpodJobIds(
  repository: DeletionRepository,
  jobId: string,
): Promise<readonly string[]> {
  const jobIds: string[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < MAX_DATABASE_PAGES; pageIndex += 1) {
    const page = await repository.findRunpodJobIds(jobId, cursor, DATABASE_PAGE_SIZE);
    jobIds.push(...page.jobIds);
    if (page.nextCursor === null) {
      return jobIds;
    }
    if (page.nextCursor === cursor) {
      throw new Error("RunPod deletion cursor did not advance");
    }
    cursor = page.nextCursor;
  }
  throw new Error("RunPod deletion pagination exceeded the safety limit");
}

async function findAllResultPrefixes(
  repository: DeletionRepository,
  jobId: string,
): Promise<readonly string[]> {
  const prefixes = new Set<string>();
  let afterGeneration = 0;
  for (let pageIndex = 0; pageIndex < MAX_DATABASE_PAGES; pageIndex += 1) {
    const page = await repository.findResultPrefixes(jobId, afterGeneration, DATABASE_PAGE_SIZE);
    for (const prefix of page.prefixes) {
      prefixes.add(prefix);
    }
    if (page.nextGeneration === null) {
      return [...prefixes];
    }
    if (page.nextGeneration <= afterGeneration) {
      throw new Error("Result-prefix deletion cursor did not advance");
    }
    afterGeneration = page.nextGeneration;
  }
  throw new Error("Result-prefix deletion pagination exceeded the safety limit");
}

async function cancelKnownRunpodJobs(
  repository: DeletionRepository,
  client: RunpodControlClient,
  candidate: DeletionCandidate,
): Promise<boolean> {
  const jobIds = await findAllRunpodJobIds(repository, candidate.jobId);
  let allConfirmed = true;
  for (const runpodJobId of jobIds) {
    try {
      const result = await client.cancel(runpodJobId);
      if (result.outcome !== "accepted" && result.outcome !== "not_found") {
        allConfirmed = false;
      }
    } catch {
      allConfirmed = false;
    }
  }
  return allConfirmed;
}

async function deleteR2Object(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch {
    throw new R2DeletionError("R2 object deletion failed");
  }
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (let batchIndex = 0; batchIndex < MAX_R2_DELETE_BATCHES; batchIndex += 1) {
    let untrustedPage: unknown;
    try {
      untrustedPage = await bucket.list({
        limit: R2_DELETE_BATCH_SIZE,
        prefix,
      });
    } catch {
      throw new R2DeletionError("R2 object listing failed");
    }
    const page = r2ListResultSchema.parse(untrustedPage);
    const keys = page.objects.map((object) => object.key);
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new Error("R2 returned an object outside the deletion prefix");
    }
    if (keys.length === 0) {
      if (page.truncated) {
        throw new Error("R2 returned an empty truncated deletion page");
      }
      return;
    }
    try {
      await bucket.delete(keys);
    } catch {
      throw new R2DeletionError("R2 prefix deletion failed");
    }
  }
  throw new Error("R2 prefix deletion exceeded the safety limit");
}

async function assertR2ObjectAbsent(bucket: R2Bucket, key: string): Promise<void> {
  let object: unknown;
  try {
    object = await bucket.head(key);
  } catch {
    throw new R2DeletionError("R2 deletion verification failed");
  }
  if (object !== null) {
    throw new R2DeletionError("R2 object remained after deletion");
  }
}

async function deleteCandidateObjects(
  bucket: R2Bucket,
  candidate: DeletionCandidate,
  prefixes: readonly string[],
): Promise<void> {
  await deleteR2Object(bucket, candidate.sourceKey);
  for (const prefix of prefixes) {
    await deleteR2Prefix(bucket, prefix);
  }
  await assertR2ObjectAbsent(bucket, candidate.sourceKey);
}

export async function processPendingDeletions(
  environment: DeletionEnvironment,
  logger: StructuredLogger,
  dependencies: DeletionDependencies = {},
): Promise<DeletionSweepResult> {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const startedAt = now();
  const timestampMilliseconds = startedAt.getTime();
  const timestamp = startedAt.toISOString();
  const repositoryFactory = dependencies.createRepository ?? createD1DeletionRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const clientFactory =
    dependencies.createRunpodClient ??
    ((clientEnvironment: DeletionEnvironment) =>
      createRunpodClient({
        apiKey: clientEnvironment.RUNPOD_API_KEY,
        endpointId: clientEnvironment.RUNPOD_ENDPOINT_ID,
      }));
  const client = clientFactory(environment);
  const candidates = await repository.findDeletionCandidates(timestamp, DELETION_BATCH_SIZE);
  let completedCount = 0;
  let deferredCount = 0;
  let retryCount = 0;

  for (const candidate of candidates) {
    const notBeforeMilliseconds = Date.parse(candidate.deletionNotBefore);
    if (timestampMilliseconds < notBeforeMilliseconds) {
      let cancellationConfirmed: boolean;
      try {
        cancellationConfirmed = await cancelKnownRunpodJobs(repository, client, candidate);
      } catch {
        cancellationConfirmed = false;
      }
      if (!cancellationConfirmed) {
        const recorded = await recordRetry(
          repository,
          candidate,
          "RUNPOD_CANCEL_FAILED",
          timestamp,
          timestampMilliseconds,
          random,
          logger,
        );
        retryCount += recorded ? 1 : 0;
        deferredCount += recorded ? 0 : 1;
        continue;
      }
      const deferred = await repository.deferDeletion({
        expectedVersion: candidate.version,
        jobId: candidate.jobId,
        nextAttemptAt: candidate.deletionNotBefore,
        timestamp,
      });
      if (deferred) {
        logger.info("job.deletion_deferred", {
          jobId: candidate.jobId,
        });
      }
      deferredCount += 1;
      continue;
    }

    let prefixes: readonly string[];
    try {
      prefixes = await findAllResultPrefixes(repository, candidate.jobId);
    } catch {
      const recorded = await recordRetry(
        repository,
        candidate,
        "D1_DELETE_FAILED",
        timestamp,
        timestampMilliseconds,
        random,
        logger,
      );
      retryCount += recorded ? 1 : 0;
      deferredCount += recorded ? 0 : 1;
      continue;
    }

    try {
      await deleteCandidateObjects(environment.RECORDINGS, candidate, prefixes);
    } catch (error) {
      if (!(error instanceof R2DeletionError)) {
        throw error;
      }
      const recorded = await recordRetry(
        repository,
        candidate,
        "R2_DELETE_FAILED",
        timestamp,
        timestampMilliseconds,
        random,
        logger,
      );
      retryCount += recorded ? 1 : 0;
      deferredCount += recorded ? 0 : 1;
      continue;
    }

    let deletionResult: Awaited<ReturnType<DeletionRepository["deleteJobRecord"]>>;
    try {
      deletionResult = await repository.deleteJobRecord({
        expectedVersion: candidate.version,
        jobId: candidate.jobId,
        timestamp,
      });
    } catch {
      const recorded = await recordRetry(
        repository,
        candidate,
        "D1_DELETE_FAILED",
        timestamp,
        timestampMilliseconds,
        random,
        logger,
      );
      retryCount += recorded ? 1 : 0;
      deferredCount += recorded ? 0 : 1;
      continue;
    }
    if (deletionResult === "deleted" || deletionResult === "not_found") {
      completedCount += 1;
      logger.info("job.deletion_completed", {
        jobId: candidate.jobId,
      });
    } else {
      deferredCount += 1;
    }
  }

  return {
    completedCount,
    deferredCount,
    retryCount,
  };
}
