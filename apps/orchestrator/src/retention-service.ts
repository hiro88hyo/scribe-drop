import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import type { StructuredLogger } from "@scribe-drop/observability";

import { parseRetentionConfig, type RetentionConfigEnvironment } from "./config.js";
import { createD1RetentionRepository, type RetentionRepository } from "./retention-repository.js";
import { R2CleanupError, deleteR2ObjectAndVerify, deleteR2Prefix } from "./r2-object-cleanup.js";

const RETENTION_BATCH_SIZE = 25;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface RetentionEnvironment extends RetentionConfigEnvironment {
  readonly RECORDINGS: R2Bucket;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface RetentionDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: D1Database) => RetentionRepository;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
}

export interface RetentionSweepResult {
  readonly auditScheduledCount: number;
  readonly resultDeletedCount: number;
  readonly retryCount: number;
  readonly sourceDeletedCount: number;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function cutoff(timestampMilliseconds: number, retentionDays: number): string {
  return new Date(timestampMilliseconds - retentionDays * DAY_MILLISECONDS).toISOString();
}

export async function processRetention(
  environment: RetentionEnvironment,
  logger: StructuredLogger,
  dependencies: RetentionDependencies = {},
): Promise<RetentionSweepResult> {
  const config = parseRetentionConfig(environment);
  if (config === undefined) {
    logger.error("retention.configuration_invalid", {
      errorCode: "INTERNAL_ERROR",
    });
    throw new Error("Retention configuration is invalid");
  }
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const timestampMilliseconds = startedAt.getTime();
  const timestamp = startedAt.toISOString();
  const repositoryFactory = dependencies.createRepository ?? createD1RetentionRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  let auditScheduledCount = 0;
  let resultDeletedCount = 0;
  let retryCount = 0;
  let sourceDeletedCount = 0;

  const sourceCandidates = await repository.findSourceRetentionCandidates(
    cutoff(timestampMilliseconds, config.sourceRetentionDays),
    RETENTION_BATCH_SIZE,
  );
  for (const candidate of sourceCandidates) {
    try {
      await deleteR2ObjectAndVerify(environment.RECORDINGS, candidate.sourceKey);
    } catch (error) {
      if (!(error instanceof R2CleanupError)) {
        throw error;
      }
      retryCount += 1;
      logger.warn("retention.retry", {
        errorCode: "R2_DELETE_FAILED",
        jobId: candidate.jobId,
      });
      continue;
    }
    const marked = await repository.markSourceDeleted({
      ...candidate,
      timestamp,
    });
    if (marked) {
      sourceDeletedCount += 1;
      logger.info("job.source_retention_completed", {
        jobId: candidate.jobId,
      });
    }
  }

  const resultCandidates = await repository.findResultRetentionCandidates(
    cutoff(timestampMilliseconds, config.resultRetentionDays),
    RETENTION_BATCH_SIZE,
  );
  for (const candidate of resultCandidates) {
    try {
      await deleteR2Prefix(environment.RECORDINGS, candidate.resultPrefix);
    } catch (error) {
      if (!(error instanceof R2CleanupError)) {
        throw error;
      }
      retryCount += 1;
      logger.warn("retention.retry", {
        attemptId: candidate.attemptId,
        errorCode: "R2_DELETE_FAILED",
        jobId: candidate.jobId,
      });
      continue;
    }
    const marked = await repository.markResultsDeleted({
      ...candidate,
      timestamp,
    });
    if (marked) {
      resultDeletedCount += 1;
      logger.info("job.result_retention_completed", {
        attemptId: candidate.attemptId,
        jobId: candidate.jobId,
      });
    }
  }

  const auditCandidates = await repository.findAuditRetentionCandidates(
    cutoff(timestampMilliseconds, config.auditRetentionDays),
    RETENTION_BATCH_SIZE,
  );
  const createEventId =
    dependencies.createEventId ??
    ((eventTimestampMilliseconds: number) =>
      createUlid(eventTimestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
  for (const candidate of auditCandidates) {
    const marked = await repository.markAuditRetentionExpired({
      cutoff: cutoff(timestampMilliseconds, config.auditRetentionDays),
      eventId: createEventId(timestampMilliseconds),
      expectedVersion: candidate.version,
      jobId: candidate.jobId,
      latestCapabilityIssuedAt: candidate.latestCapabilityIssuedAt,
      timestamp,
    });
    if (marked) {
      auditScheduledCount += 1;
      logger.info("job.audit_retention_scheduled", {
        jobId: candidate.jobId,
      });
    }
  }

  return {
    auditScheduledCount,
    resultDeletedCount,
    retryCount,
    sourceDeletedCount,
  };
}
