import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type { RunpodConfig } from "./config.js";
import type { MaintenanceRepository } from "./maintenance-repository.js";
import type { RunpodControlRepository } from "./runpod-control-repository.js";
import type { DeletionSweepResult } from "./deletion-service.js";
import { reconcileJobs, type ReconciliationEnvironment } from "./reconciliation-service.js";
import type { RetentionSweepResult } from "./retention-service.js";

const NOW = new Date("2026-07-25T00:15:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PENDING_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

function environment(
  overrides: Partial<ReconciliationEnvironment> = {},
): ReconciliationEnvironment {
  return {
    APP_ENV: "local",
    AUDIT_RETENTION_DAYS: "180",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    MULTIPART_RETENTION_HOURS: "24",
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_BUCKET_NAME: "scribe-drop-local",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
    RESULT_RETENTION_DAYS: "90",
    RUNPOD_ALLOWED_GPU_IDS:
      "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition",
    RUNPOD_API_KEY: "runpod-api-key-placeholder",
    RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
    RUNPOD_INTERNAL_BASE_URL: "https://orchestrator.example.invalid",
    RUNPOD_WORKER_IMAGE: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64),
    SOURCE_RETENTION_DAYS: "7",
    RECORDINGS: {} as R2Bucket,
    SCRIBE_DROP_DB: {} as D1Database,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<RunpodControlRepository> = {}): RunpodControlRepository {
  return {
    cancelExpiredUnboundSubmission: () => Promise.resolve(false),
    claimWinner: () => Promise.resolve(false),
    failExpiredUnknownSubmission: () => Promise.resolve(false),
    findClaimContext: () => Promise.resolve(undefined),
    findDispatchablePendingJobId: () => Promise.resolve(undefined),
    findExpiredUnknownSubmissions: () => Promise.resolve([]),
    findExpiredUnboundCancellations: () => Promise.resolve([]),
    findFailedUnclaimedSubmissions: () => Promise.resolve([]),
    findStaleAcceptedSubmissions: () => Promise.resolve([]),
    failStaleAcceptedSubmission: () => Promise.resolve(false),
    markHeartbeat: () => Promise.resolve(false),
    markFailedUnclaimedSubmissionCancelled: () => Promise.resolve(false),
    prepareSubmission: () => Promise.resolve(undefined),
    recordClaimSubmission: () => Promise.resolve(),
    recordSubmissionAccepted: () => Promise.resolve(false),
    recordSubmissionRejected: () => Promise.resolve(false),
    recordSubmissionUnknown: () => Promise.resolve(false),
    ...overrides,
  };
}

function fakeMaintenanceRepository(): MaintenanceRepository {
  return {
    expireUpload: () => Promise.resolve(false),
    findExpiredUploads: () => Promise.resolve([]),
  };
}

function testLogger(records: string[]): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: (record) => {
      records.push(record);
    },
  });
}

function emptyDeletionSweep(): Promise<DeletionSweepResult> {
  return Promise.resolve({
    completedCount: 0,
    deferredCount: 0,
    retryCount: 0,
  });
}

function emptyRetentionSweep(): Promise<RetentionSweepResult> {
  return Promise.resolve({
    auditScheduledCount: 0,
    resultDeletedCount: 0,
    retryCount: 0,
    sourceDeletedCount: 0,
  });
}

describe("reconciliation service", () => {
  it("expires stale unknown submissions before dispatching one pending job", async () => {
    const order: string[] = [];
    const failExpiredUnknownSubmission = vi.fn<
      RunpodControlRepository["failExpiredUnknownSubmission"]
    >(() => {
      order.push("expire");
      return Promise.resolve(true);
    });
    const submitPendingJob = vi.fn(
      (
        jobId: string,
        _environment: ReconciliationEnvironment,
        config: RunpodConfig,
        _logger: StructuredLogger,
      ) => {
        void _environment;
        void _logger;
        order.push("dispatch");
        expect(jobId).toBe(PENDING_JOB_ID);
        expect(config.runpodEndpointId).toBe("endpoint-placeholder");
        return Promise.resolve("accepted" as const);
      },
    );
    const records: string[] = [];

    await expect(
      reconcileJobs(environment(), {
        createEventId: () => EVENT_ID,
        createMaintenanceRepository: () => fakeMaintenanceRepository(),
        createRepository: () =>
          fakeRepository({
            failExpiredUnknownSubmission,
            findDispatchablePendingJobId: () => Promise.resolve(PENDING_JOB_ID),
            findExpiredUnknownSubmissions: () =>
              Promise.resolve([
                {
                  attemptId: ATTEMPT_ID,
                  claimExpiresAt: NOW.toISOString(),
                  jobId: JOB_ID,
                },
              ]),
          }),
        logger: testLogger(records),
        now: () => NOW,
        processDeletions: emptyDeletionSweep,
        processRetention: emptyRetentionSweep,
        dispatchNotification: () => Promise.resolve("none"),
        reconcileCompletions: () =>
          Promise.resolve({
            cancelledCount: 0,
            completedCount: 0,
            failedCount: 0,
            terminalObservedCount: 0,
          }),
        submitPendingJob,
      }),
    ).resolves.toEqual({
      cancelledUnboundCount: 0,
      cancelledStaleSubmissionCount: 0,
      completion: {
        cancelledCount: 0,
        completedCount: 0,
        failedCount: 0,
        terminalObservedCount: 0,
      },
      deletion: {
        completedCount: 0,
        deferredCount: 0,
        retryCount: 0,
      },
      dispatch: "accepted",
      expiredSubmissionCount: 1,
      expiredUploadCount: 0,
      notification: "none",
      retention: {
        auditScheduledCount: 0,
        resultDeletedCount: 0,
        retryCount: 0,
        sourceDeletedCount: 0,
      },
      staleAcceptedSubmissionCount: 0,
      staleCancellationDeferredCount: 0,
    });

    expect(order).toEqual(["expire", "dispatch"]);
    expect(failExpiredUnknownSubmission).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      eventId: EVENT_ID,
      jobId: JOB_ID,
      timestamp: NOW.toISOString(),
    });
    expect(records.join("\n")).toContain('"event":"job.submission_expired"');
    expect(records.join("\n")).toContain('"event":"reconciliation.completed"');
  });

  it("fails and cancels an accepted submission that misses the ten-minute start SLO", async () => {
    const failStaleAcceptedSubmission = vi.fn<
      RunpodControlRepository["failStaleAcceptedSubmission"]
    >(() => Promise.resolve(true));
    const markFailedUnclaimedSubmissionCancelled = vi.fn<
      RunpodControlRepository["markFailedUnclaimedSubmissionCancelled"]
    >(() => Promise.resolve(true));
    const cancelStaleSubmission = vi.fn(() => Promise.resolve({ outcome: "accepted" as const }));
    const records: string[] = [];

    const result = await reconcileJobs(environment(), {
      cancelStaleSubmission,
      createEventId: () => EVENT_ID,
      createMaintenanceRepository: () => fakeMaintenanceRepository(),
      createRepository: () =>
        fakeRepository({
          failStaleAcceptedSubmission,
          findStaleAcceptedSubmissions: () =>
            Promise.resolve([
              {
                attemptId: ATTEMPT_ID,
                jobId: JOB_ID,
                runpodJobId: "accepted-provider-job",
                submissionFinishedAt: "2026-07-25T00:04:59.999Z",
              },
            ]),
          markFailedUnclaimedSubmissionCancelled,
        }),
      dispatchNotification: () => Promise.resolve("none"),
      logger: testLogger(records),
      now: () => NOW,
      processDeletions: emptyDeletionSweep,
      processRetention: emptyRetentionSweep,
      reconcileCompletions: () =>
        Promise.resolve({
          cancelledCount: 0,
          completedCount: 0,
          failedCount: 0,
          terminalObservedCount: 0,
        }),
    });

    expect(result).toMatchObject({
      cancelledStaleSubmissionCount: 1,
      staleAcceptedSubmissionCount: 1,
      staleCancellationDeferredCount: 0,
    });
    expect(failStaleAcceptedSubmission).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      eventId: EVENT_ID,
      jobId: JOB_ID,
      runpodJobId: "accepted-provider-job",
      staleBefore: "2026-07-25T00:05:00.000Z",
      timestamp: NOW.toISOString(),
    });
    expect(cancelStaleSubmission).toHaveBeenCalledWith(
      "accepted-provider-job",
      expect.any(Object),
      expect.objectContaining({ runpodEndpointId: "endpoint-placeholder" }),
    );
    expect(markFailedUnclaimedSubmissionCancelled).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      eventId: EVENT_ID,
      jobId: JOB_ID,
      runpodJobId: "accepted-provider-job",
      timestamp: NOW.toISOString(),
    });
    expect(records.join("\n")).toContain('"event":"job.submission_start_slo_exceeded"');
    expect(records.join("\n")).toContain('"event":"job.submission_cancelled"');
  });

  it("retries cancellation of a failed unclaimed submission without restoring it", async () => {
    const cancelStaleSubmission = vi.fn(() => Promise.resolve({ outcome: "unavailable" as const }));
    const records: string[] = [];

    const result = await reconcileJobs(environment(), {
      cancelStaleSubmission,
      createMaintenanceRepository: () => fakeMaintenanceRepository(),
      createRepository: () =>
        fakeRepository({
          findFailedUnclaimedSubmissions: () =>
            Promise.resolve([
              {
                attemptId: ATTEMPT_ID,
                jobId: JOB_ID,
                runpodJobId: "accepted-provider-job",
                submissionFinishedAt: "2026-07-25T00:00:01.000Z",
              },
            ]),
        }),
      dispatchNotification: () => Promise.resolve("none"),
      logger: testLogger(records),
      now: () => NOW,
      processDeletions: emptyDeletionSweep,
      processRetention: emptyRetentionSweep,
      reconcileCompletions: () =>
        Promise.resolve({
          cancelledCount: 0,
          completedCount: 0,
          failedCount: 0,
          terminalObservedCount: 0,
        }),
    });

    expect(result).toMatchObject({
      cancelledStaleSubmissionCount: 0,
      staleAcceptedSubmissionCount: 0,
      staleCancellationDeferredCount: 1,
    });
    expect(records.join("\n")).toContain('"event":"job.submission_cancel_deferred"');
    expect(records.join("\n")).not.toContain('"event":"job.submission_cancelled"');
  });

  it("fails closed before touching D1 when configuration is invalid", async () => {
    const createRepository = vi.fn();
    const records: string[] = [];

    await expect(
      reconcileJobs(environment({ RUNPOD_API_KEY: "" }), {
        createRepository,
        logger: testLogger(records),
        now: () => NOW,
        processDeletions: emptyDeletionSweep,
        processRetention: emptyRetentionSweep,
      }),
    ).rejects.toThrow("Reconciliation configuration is invalid");

    expect(createRepository).not.toHaveBeenCalled();
    expect(records.join("\n")).toContain('"event":"reconciliation.configuration_invalid"');
  });
});
