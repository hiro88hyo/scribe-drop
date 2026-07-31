import { createUlid, type RandomBytes } from "@scribe-drop/domain";
import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";

import { reconcileRunpodCompletions, type CompletionResult } from "./completion-service.js";
import {
  parseOrchestratorConfig,
  parseRunpodConfig,
  type RunpodConfig,
  type RunpodConfigEnvironment,
  type NotificationConfigEnvironment,
  type RetentionConfigEnvironment,
} from "./config.js";
import {
  dispatchNextNotification,
  type NotificationDispatchResult,
} from "./notification-service.js";
import { processPendingDeletions, type DeletionSweepResult } from "./deletion-service.js";
import { processRetention, type RetentionSweepResult } from "./retention-service.js";
import {
  createD1MaintenanceRepository,
  type MaintenanceRepository,
} from "./maintenance-repository.js";
import {
  createD1RunpodControlRepository,
  type RunpodControlRepository,
} from "./runpod-control-repository.js";
import { createRunpodClient, type RunpodCancelResult } from "./runpod-client.js";
import {
  submitPendingRunpodJob,
  type SubmissionDispatchResult,
} from "./runpod-submission-service.js";

const RECONCILIATION_BATCH_SIZE = 25;
export const ACCEPTED_SUBMISSION_START_SLO_MS = 10 * 60 * 1_000;

export interface ReconciliationEnvironment
  extends RunpodConfigEnvironment, NotificationConfigEnvironment, RetentionConfigEnvironment {
  readonly RECORDINGS: R2Bucket;
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface ReconciliationDependencies {
  readonly cancelStaleSubmission?: (
    runpodJobId: string,
    environment: ReconciliationEnvironment,
    config: RunpodConfig,
  ) => Promise<RunpodCancelResult>;
  readonly createEventId?: (timestampMilliseconds: number) => string;
  readonly createMaintenanceRepository?: (database: D1Database) => MaintenanceRepository;
  readonly createRepository?: (database: D1Database) => RunpodControlRepository;
  readonly logger?: StructuredLogger;
  readonly now?: () => Date;
  readonly dispatchNotification?: (
    environment: ReconciliationEnvironment,
    logger: StructuredLogger,
  ) => Promise<NotificationDispatchResult>;
  readonly randomBytes?: RandomBytes;
  readonly processDeletions?: (
    environment: ReconciliationEnvironment,
    logger: StructuredLogger,
  ) => Promise<DeletionSweepResult>;
  readonly processRetention?: (
    environment: ReconciliationEnvironment,
    logger: StructuredLogger,
  ) => Promise<RetentionSweepResult>;
  readonly reconcileCompletions?: (
    environment: ReconciliationEnvironment,
    logger: StructuredLogger,
  ) => Promise<CompletionResult>;
  readonly submitPendingJob?: (
    jobId: string,
    environment: ReconciliationEnvironment,
    config: RunpodConfig,
    logger: StructuredLogger,
  ) => Promise<SubmissionDispatchResult>;
}

export interface ReconciliationResult {
  readonly cancelledUnboundCount: number;
  readonly cancelledStaleSubmissionCount: number;
  readonly completion: CompletionResult;
  readonly deletion: DeletionSweepResult;
  readonly dispatch: SubmissionDispatchResult | "none";
  readonly expiredSubmissionCount: number;
  readonly expiredUploadCount: number;
  readonly notification: NotificationDispatchResult;
  readonly retention: RetentionSweepResult;
  readonly staleAcceptedSubmissionCount: number;
  readonly staleCancellationDeferredCount: number;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function reconcileJobs(
  environment: ReconciliationEnvironment,
  dependencies: ReconciliationDependencies = {},
): Promise<ReconciliationResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const timestamp = startedAt.toISOString();
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
  const config = parseRunpodConfig(environment);
  if (config === undefined) {
    logger.error("reconciliation.configuration_invalid", {
      errorCode: "INTERNAL_ERROR",
    });
    throw new Error("Reconciliation configuration is invalid");
  }

  try {
    const repositoryFactory = dependencies.createRepository ?? createD1RunpodControlRepository;
    const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
    const cancelStaleSubmission =
      dependencies.cancelStaleSubmission ??
      ((runpodJobId: string, _environment: ReconciliationEnvironment, runpodConfig: RunpodConfig) =>
        createRunpodClient({
          apiKey: runpodConfig.runpodApiKey,
          endpointId: runpodConfig.runpodEndpointId,
        }).cancel(runpodJobId));
    const processDeletions =
      dependencies.processDeletions ??
      ((deletionEnvironment: ReconciliationEnvironment, deletionLogger: StructuredLogger) =>
        processPendingDeletions(deletionEnvironment, deletionLogger, { now }));
    const deletion = await processDeletions(environment, logger);
    const runRetention =
      dependencies.processRetention ??
      ((retentionEnvironment: ReconciliationEnvironment, retentionLogger: StructuredLogger) =>
        processRetention(retentionEnvironment, retentionLogger, {
          now,
          ...(dependencies.randomBytes === undefined
            ? {}
            : { randomBytes: dependencies.randomBytes }),
        }));
    const retention = await runRetention(environment, logger);
    const expired = await repository.findExpiredUnknownSubmissions(
      timestamp,
      RECONCILIATION_BATCH_SIZE,
    );
    const staleBefore = new Date(
      startedAt.getTime() - ACCEPTED_SUBMISSION_START_SLO_MS,
    ).toISOString();
    const staleAccepted = await repository.findStaleAcceptedSubmissions(
      staleBefore,
      RECONCILIATION_BATCH_SIZE,
    );
    const createEventId =
      dependencies.createEventId ??
      ((timestampMilliseconds: number) =>
        createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
    let expiredSubmissionCount = 0;
    let expiredUploadCount = 0;
    let staleAcceptedSubmissionCount = 0;
    let cancelledStaleSubmissionCount = 0;
    let staleCancellationDeferredCount = 0;

    const maintenanceRepositoryFactory =
      dependencies.createMaintenanceRepository ?? createD1MaintenanceRepository;
    const maintenanceRepository = maintenanceRepositoryFactory(environment.SCRIBE_DROP_DB);
    const expiredUploads = await maintenanceRepository.findExpiredUploads(
      timestamp,
      RECONCILIATION_BATCH_SIZE,
    );
    for (const upload of expiredUploads) {
      const expiredUpload = await maintenanceRepository.expireUpload({
        eventId: createEventId(startedAt.getTime()),
        jobId: upload.jobId,
        timestamp,
      });
      if (expiredUpload) {
        expiredUploadCount += 1;
        logger.info("upload_expired", {
          errorCode: "UPLOAD_EXPIRED",
          jobId: upload.jobId,
          status: "EXPIRED",
        });
      }
    }

    for (const submission of expired) {
      const failed = await repository.failExpiredUnknownSubmission({
        attemptId: submission.attemptId,
        eventId: createEventId(startedAt.getTime()),
        jobId: submission.jobId,
        timestamp,
      });
      if (failed) {
        expiredSubmissionCount += 1;
        logger.warn("job.submission_expired", {
          attemptId: submission.attemptId,
          errorCode: "PROCESSING_FAILED",
          jobId: submission.jobId,
          status: "FAILED",
        });
      } else {
        logger.info("reconciliation.state_conflict", {
          attemptId: submission.attemptId,
          jobId: submission.jobId,
        });
      }
    }

    const cancelFailedSubmission = async (submission: {
      readonly attemptId: string;
      readonly jobId: string;
      readonly runpodJobId: string;
    }): Promise<void> => {
      const cancellation = await cancelStaleSubmission(submission.runpodJobId, environment, config);
      if (cancellation.outcome !== "accepted" && cancellation.outcome !== "not_found") {
        staleCancellationDeferredCount += 1;
        logger.warn("job.submission_cancel_deferred", {
          attemptId: submission.attemptId,
          errorCode: "RUNPOD_CANCEL_DEFERRED",
          jobId: submission.jobId,
          runpodJobId: submission.runpodJobId,
          status: "FAILED",
        });
        return;
      }
      const recorded = await repository.markFailedUnclaimedSubmissionCancelled({
        attemptId: submission.attemptId,
        eventId: createEventId(startedAt.getTime()),
        jobId: submission.jobId,
        runpodJobId: submission.runpodJobId,
        timestamp,
      });
      if (recorded) {
        cancelledStaleSubmissionCount += 1;
        logger.info("job.submission_cancelled", {
          attemptId: submission.attemptId,
          jobId: submission.jobId,
          runpodJobId: submission.runpodJobId,
          status: "FAILED",
        });
      } else {
        logger.info("reconciliation.state_conflict", {
          attemptId: submission.attemptId,
          jobId: submission.jobId,
        });
      }
    };

    const pendingCancellation =
      await repository.findFailedUnclaimedSubmissions(RECONCILIATION_BATCH_SIZE);
    for (const submission of pendingCancellation) {
      await cancelFailedSubmission(submission);
    }

    for (const submission of staleAccepted) {
      const failed = await repository.failStaleAcceptedSubmission({
        attemptId: submission.attemptId,
        eventId: createEventId(startedAt.getTime()),
        jobId: submission.jobId,
        runpodJobId: submission.runpodJobId,
        staleBefore,
        timestamp,
      });
      if (!failed) {
        logger.info("reconciliation.state_conflict", {
          attemptId: submission.attemptId,
          jobId: submission.jobId,
        });
        continue;
      }
      staleAcceptedSubmissionCount += 1;
      logger.warn("job.submission_start_slo_exceeded", {
        attemptId: submission.attemptId,
        errorCode: "PROCESSING_FAILED",
        jobId: submission.jobId,
        runpodJobId: submission.runpodJobId,
        status: "FAILED",
      });
      await cancelFailedSubmission(submission);
    }

    let cancelledUnboundCount = 0;
    const unboundCancellations = await repository.findExpiredUnboundCancellations(
      timestamp,
      RECONCILIATION_BATCH_SIZE,
    );
    for (const cancellation of unboundCancellations) {
      const cancelled = await repository.cancelExpiredUnboundSubmission({
        attemptId: cancellation.attemptId,
        eventId: createEventId(startedAt.getTime()),
        jobId: cancellation.jobId,
        timestamp,
      });
      if (cancelled) {
        cancelledUnboundCount += 1;
        logger.info("job.cancelled", {
          attemptId: cancellation.attemptId,
          jobId: cancellation.jobId,
          status: "CANCELLED",
        });
      } else {
        logger.info("reconciliation.state_conflict", {
          attemptId: cancellation.attemptId,
          jobId: cancellation.jobId,
        });
      }
    }

    const reconcileCompletions =
      dependencies.reconcileCompletions ??
      ((completionEnvironment: ReconciliationEnvironment, completionLogger: StructuredLogger) =>
        reconcileRunpodCompletions(completionEnvironment, completionLogger, {
          now,
          ...(dependencies.randomBytes === undefined
            ? {}
            : { randomBytes: dependencies.randomBytes }),
        }));
    const completion = await reconcileCompletions(environment, logger);
    const dispatchNotification =
      dependencies.dispatchNotification ??
      ((notificationEnvironment: ReconciliationEnvironment, notificationLogger: StructuredLogger) =>
        dispatchNextNotification(notificationEnvironment, notificationLogger, {
          now,
        }));
    const notification = await dispatchNotification(environment, logger);
    const pendingJobId = await repository.findDispatchablePendingJobId();
    let dispatch: SubmissionDispatchResult | "none" = "none";
    if (pendingJobId !== undefined) {
      const submit =
        dependencies.submitPendingJob ??
        ((
          jobId: string,
          submissionEnvironment: ReconciliationEnvironment,
          runpodConfig: RunpodConfig,
          submissionLogger: StructuredLogger,
        ) =>
          submitPendingRunpodJob(
            jobId,
            {
              RUNPOD_API_KEY: runpodConfig.runpodApiKey,
              RUNPOD_ENDPOINT_ID: runpodConfig.runpodEndpointId,
              SCRIBE_DROP_DB: submissionEnvironment.SCRIBE_DROP_DB,
            },
            { logger: submissionLogger },
          ));
      dispatch = await submit(pendingJobId, environment, config, logger);
    }

    logger.info("reconciliation.completed", {
      elapsedMs: Math.max(0, now().getTime() - startedAt.getTime()),
    });
    return {
      cancelledUnboundCount,
      cancelledStaleSubmissionCount,
      completion,
      deletion,
      dispatch,
      expiredSubmissionCount,
      expiredUploadCount,
      notification,
      retention,
      staleAcceptedSubmissionCount,
      staleCancellationDeferredCount,
    };
  } catch (error) {
    logger.error("reconciliation.dependency_failure", {
      errorCode: "INTERNAL_ERROR",
    });
    throw error;
  }
}
