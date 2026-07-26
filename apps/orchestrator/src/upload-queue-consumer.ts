import {
  normalizedR2ObjectCreatedEventSchema,
  r2EventNotificationSchema,
} from "@scribe-drop/contracts";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { z } from "zod";

import {
  parseOrchestratorConfig,
  parseRunpodConfig,
  type OrchestratorConfigEnvironment,
  type RunpodConfig,
  type RunpodConfigEnvironment,
} from "./config.js";
import { parseSourceObjectKey } from "./source-object-key.js";
import {
  createD1UploadIngestionRepository,
  type UploadIngestionRepository,
} from "./upload-ingestion-repository.js";

const MAX_RETRY_DELAY_SECONDS = 15 * 60;
const BASE_RETRY_DELAY_SECONDS = 15;
const INITIAL_SOURCE_STATUSES = new Set(["CREATED", "UPLOADING", "UPLOADED"]);
const MUTABLE_SOURCE_STATUSES = new Set([
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "SUBMISSION_PENDING",
  "SUBMITTING",
  "RUNNING",
  "CANCEL_REQUESTED",
]);
const r2HeadResultSchema = z.object({
  etag: z.string().min(1).max(512),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(5 * 1024 * 1024 * 1024 * 1024),
});

export interface UploadQueueEnvironment
  extends OrchestratorConfigEnvironment, RunpodConfigEnvironment {
  readonly RECORDINGS: R2Bucket;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface UploadQueueMessage {
  readonly attempts: number;
  readonly body: unknown;
  ack(): void;
  retry(options: { readonly delaySeconds: number }): void;
}

export interface UploadQueueBatch {
  readonly messages: readonly UploadQueueMessage[];
}

export interface UploadQueueDependencies {
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: D1Database) => UploadIngestionRepository;
  readonly createAttemptId?: (timestampMilliseconds: number) => string;
  readonly headSourceObject?: (bucket: R2Bucket, key: string) => Promise<unknown>;
  readonly logger?: StructuredLogger;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly randomBytes?: RandomBytes;
  readonly submitPendingJob?: (
    jobId: string,
    database: D1Database,
    config: RunpodConfig,
    logger: StructuredLogger,
  ) => Promise<unknown>;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function retryDelaySeconds(attempts: number, random: () => number): number {
  const normalizedAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  const cap = Math.min(
    MAX_RETRY_DELAY_SECONDS,
    BASE_RETRY_DELAY_SECONDS * 2 ** Math.min(normalizedAttempts - 1, 10),
  );
  const sample = random();
  const normalizedSample = Number.isFinite(sample) ? Math.min(0.999_999, Math.max(0, sample)) : 0;
  return Math.max(1, Math.floor(normalizedSample * cap) + 1);
}

async function processMessage(
  message: UploadQueueMessage,
  environment: UploadQueueEnvironment,
  dependencies: UploadQueueDependencies,
  logger: StructuredLogger,
): Promise<"ack" | "retry"> {
  const config = parseOrchestratorConfig(environment);
  if (config === undefined) {
    logger.error("upload_event_configuration_invalid", {
      errorCode: "INTERNAL_ERROR",
    });
    return "retry";
  }

  const eventResult = r2EventNotificationSchema.safeParse(message.body);
  if (!eventResult.success) {
    logger.warn("upload_event_rejected", {
      errorCode: "INVALID_REQUEST",
    });
    return "ack";
  }
  const event = eventResult.data;
  if (event.account !== config.cloudflareAccountId || event.bucket !== config.r2BucketName) {
    logger.warn("upload_event_rejected", {
      errorCode: "INVALID_REQUEST",
    });
    return "ack";
  }

  const parsedKey = parseSourceObjectKey(event.object.key);
  if (parsedKey === undefined) {
    logger.warn("upload_event_rejected", {
      errorCode: "INVALID_REQUEST",
    });
    return "ack";
  }

  const normalized = normalizedR2ObjectCreatedEventSchema.safeParse({
    bucket: event.bucket,
    etag: event.object.eTag,
    eventType: "object-create",
    jobId: parsedKey.jobId,
    key: event.object.key,
    occurredAt: event.eventTime,
    sizeBytes: event.object.size,
  });
  const repositoryFactory = dependencies.createRepository ?? createD1UploadIngestionRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const job = await repository.findSourceJob(parsedKey.jobId);
  if (job === undefined) {
    logger.warn("upload_event_job_not_found", {
      errorCode: "NOT_FOUND",
      jobId: parsedKey.jobId,
    });
    return "ack";
  }
  if (job.sourceBucket !== event.bucket || job.sourceKey !== event.object.key) {
    logger.warn("upload_event_source_mismatch", {
      errorCode: "INVALID_REQUEST",
      jobId: job.id,
    });
    return "ack";
  }
  const headSourceObject =
    dependencies.headSourceObject ?? ((bucket: R2Bucket, key: string) => bucket.head(key));
  const untrustedHead = await headSourceObject(environment.RECORDINGS, job.sourceKey);
  if (untrustedHead === null) {
    logger.warn("upload_event_source_unavailable", {
      errorCode: "SOURCE_NOT_FOUND",
      jobId: job.id,
    });
    return "retry";
  }
  const headResult = r2HeadResultSchema.safeParse(untrustedHead);
  if (!headResult.success) {
    throw new Error("R2 HEAD returned invalid metadata");
  }

  const now = dependencies.now?.() ?? new Date();
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
  if (headResult.data.etag !== event.object.eTag || headResult.data.size !== event.object.size) {
    if (job.sourceEtag !== null && job.sourceEtag !== headResult.data.etag) {
      const marked = await repository.markSourceMutated(
        job,
        headResult.data.etag,
        createEventId(now.getTime()),
        now.toISOString(),
      );
      if (!marked) {
        const current = await repository.findSourceJob(job.id);
        if (
          current !== undefined &&
          MUTABLE_SOURCE_STATUSES.has(current.status) &&
          current.sourceEtag !== headResult.data.etag
        ) {
          return "retry";
        }
      }
      logger.warn("upload_event_source_mutated", {
        errorCode: "SOURCE_ETAG_CHANGED",
        jobId: job.id,
      });
    } else {
      logger.info("upload_event_stale", {
        jobId: job.id,
      });
    }
    return "ack";
  }
  if (job.sourceEtag !== null && job.sourceEtag !== headResult.data.etag) {
    const marked = await repository.markSourceMutated(
      job,
      headResult.data.etag,
      createEventId(now.getTime()),
      now.toISOString(),
    );
    if (!marked) {
      const current = await repository.findSourceJob(job.id);
      if (
        current !== undefined &&
        MUTABLE_SOURCE_STATUSES.has(current.status) &&
        current.sourceEtag !== headResult.data.etag
      ) {
        return "retry";
      }
    }
    logger.warn("upload_event_source_mutated", {
      errorCode: "SOURCE_ETAG_CHANGED",
      jobId: job.id,
    });
    return "ack";
  }
  if (headResult.data.size !== job.expectedSizeBytes) {
    const failed = await repository.failSource(
      job,
      "SOURCE_SIZE_MISMATCH",
      createEventId(now.getTime()),
      now.toISOString(),
    );
    if (!failed) {
      const current = await repository.findSourceJob(job.id);
      if (current !== undefined && INITIAL_SOURCE_STATUSES.has(current.status)) {
        return "retry";
      }
    }
    logger.warn("upload_event_source_rejected", {
      errorCode: "SOURCE_SIZE_MISMATCH",
      jobId: job.id,
      sizeBytes: headResult.data.size,
    });
    return "ack";
  }
  if (!normalized.success) {
    throw new Error("Verified R2 event could not be normalized");
  }
  if (event.action !== "CompleteMultipartUpload") {
    const failed = await repository.failSource(
      job,
      "PROCESSING_FAILED",
      createEventId(now.getTime()),
      now.toISOString(),
    );
    if (!failed) {
      const current = await repository.findSourceJob(job.id);
      if (current !== undefined && INITIAL_SOURCE_STATUSES.has(current.status)) {
        return "retry";
      }
    }
    logger.warn("upload_event_source_rejected", {
      errorCode: "PROCESSING_FAILED",
      jobId: job.id,
    });
    return "ack";
  }

  const createAttemptId =
    dependencies.createAttemptId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
  const attemptId = job.generationOneAttemptId ?? createAttemptId(now.getTime());
  const result = await repository.ingestSource({
    attemptId,
    eventId: createEventId(now.getTime()),
    job,
    ownerHash: parsedKey.ownerHash,
    sizeBytes: headResult.data.size,
    sourceEtag: headResult.data.etag,
    timestamp: now.toISOString(),
  });
  if (result === "conflict") {
    logger.warn("upload_event_state_conflict", {
      errorCode: "CONFLICT",
      jobId: job.id,
    });
    return "retry";
  }
  const logEvent =
    result === "ingested"
      ? "upload_event_ingested"
      : result === "ignored"
        ? "upload_event_ignored"
        : "upload_event_duplicate";
  logger.info(logEvent, {
    attemptId,
    jobId: job.id,
    sizeBytes: headResult.data.size,
    status: "SUBMISSION_PENDING",
  });
  if (dependencies.submitPendingJob !== undefined) {
    const runpodConfig = parseRunpodConfig(environment);
    if (runpodConfig === undefined) {
      logger.error("upload_event_configuration_invalid", {
        errorCode: "INTERNAL_ERROR",
        jobId: job.id,
      });
      return "retry";
    }
    await dependencies.submitPendingJob(job.id, environment.SCRIBE_DROP_DB, runpodConfig, logger);
  }
  return "ack";
}

export async function handleUploadQueueBatch(
  batch: UploadQueueBatch,
  environment: UploadQueueEnvironment,
  dependencies: UploadQueueDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  const logger =
    dependencies.logger ??
    createStructuredLogger({
      environment: parseOrchestratorConfig(environment)?.appEnvironment ?? "local",
      now,
      service: "orchestrator",
      sink: (serializedRecord) => {
        console.log(serializedRecord);
      },
    });
  const random = dependencies.random ?? Math.random;

  for (const message of batch.messages) {
    try {
      const outcome = await processMessage(message, environment, dependencies, logger);
      if (outcome === "ack") {
        message.ack();
      } else {
        message.retry({
          delaySeconds: retryDelaySeconds(message.attempts, random),
        });
      }
    } catch {
      logger.error("upload_event_dependency_failure", {
        errorCode: "INTERNAL_ERROR",
      });
      message.retry({
        delaySeconds: retryDelaySeconds(message.attempts, random),
      });
    }
  }
}
