import type { CloudRunControllerRequest, CloudRunControllerResponse } from "@scribe-drop/contracts";
import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudRunControlRepository,
  CloudRunReconciliationCandidate,
} from "./cloud-run-control-repository.js";
import {
  reconcileCloudRunJobs,
  type CloudRunReconciliationEnvironment,
} from "./cloud-run-reconciliation-service.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const candidate: CloudRunReconciliationCandidate = {
  attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  cleanupStatus: "NOT_REQUESTED",
  executionStatus: "CREATING",
  executionUpdatedAt: "2026-08-12T23:50:00.000Z",
  executionVersion: 2,
  jobDeleted: false,
  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  jobStatus: "SUBMITTING",
  providerHandle: "h".repeat(43),
  providerVersion: 3,
  terminalStatus: null,
};

function environment(): CloudRunReconciliationEnvironment {
  return {
    APP_ENV: "staging",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    CLOUD_RUN_CONTROLLER_ORIGIN:
      "https://scribe-drop-staging-gpu-controller-123456789012.asia-southeast1.run.app",
    CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-staging.example.invalid",
    CLOUD_RUN_RUNTIME_DERIVATION_SECRET: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
    CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
    CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_BUCKET_NAME: "recording-transcriber-staging",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
    SCRIBE_DROP_DB: {} as D1Database,
  };
}

function repository(selected: CloudRunReconciliationCandidate): CloudRunControlRepository {
  return {
    applyControllerResponse: () => Promise.resolve(true),
    failMissingTerminal: () => Promise.resolve(true),
    findDispatchablePendingJobId: () => Promise.resolve(undefined),
    findReconciliationCandidates: () => Promise.resolve([selected]),
    findSubmissionCandidate: () => Promise.resolve(undefined),
    prepareSubmission: () => Promise.resolve(undefined),
    recordCreateResponse: () => Promise.resolve(false),
    recordCreateRejected: () => Promise.resolve(false),
    recordCreateUnknown: () => Promise.resolve(false),
  };
}

function logger(): StructuredLogger {
  return createStructuredLogger({
    environment: "staging",
    now: () => NOW,
    service: "orchestrator",
    sink: () => undefined,
  });
}

describe("Cloud Run reconciliation", () => {
  it("replays one exact request and completes one stale-version recovery in the same sweep", async () => {
    const mutate = vi
      .fn<(request: CloudRunControllerRequest) => Promise<CloudRunControllerResponse>>()
      .mockRejectedValueOnce(new Error("lost"))
      .mockImplementationOnce((request) =>
        Promise.resolve({
          errorCode: "STALE_VERSION",
          executionHandle: request.executionHandle,
          outcome: "rejected",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 5,
        }),
      )
      .mockImplementationOnce((request) =>
        Promise.resolve({
          errorCode: null,
          executionHandle: request.executionHandle,
          outcome: "cleaned",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 6,
        }),
      );
    const selectedRepository = repository({
      ...candidate,
      cleanupStatus: "PENDING",
      executionStatus: "TERMINAL",
      providerVersion: 3,
      terminalStatus: "COMPLETED",
    });
    const apply = vi.spyOn(selectedRepository, "applyControllerResponse");
    let randomByte = 1;
    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length).fill(randomByte++),
      }),
    ).resolves.toEqual({
      appliedCount: 2,
      deferredCount: 0,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    });
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate.mock.calls[0]?.[0]).toEqual(mutate.mock.calls[1]?.[0]);
    expect(mutate.mock.calls[2]?.[0]).toMatchObject({
      action: "cleanup",
      expectedVersion: 5,
    });
    expect(mutate.mock.calls[2]?.[0].requestId).not.toBe(mutate.mock.calls[0]?.[0].requestId);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]?.[0].action).toBe("cleanup");
    expect(apply.mock.calls[0]?.[0].response).toMatchObject({
      errorCode: "STALE_VERSION",
      version: 5,
    });
    expect(apply.mock.calls[1]?.[0]).toMatchObject({
      action: "cleanup",
      candidate: {
        executionVersion: candidate.executionVersion + 1,
        providerVersion: 5,
      },
      response: { errorCode: null, outcome: "cleaned", version: 6 },
    });
  });

  it("defers after one stale-version recovery when the controller version moves again", async () => {
    const mutate = vi
      .fn<(request: CloudRunControllerRequest) => Promise<CloudRunControllerResponse>>()
      .mockImplementationOnce((request) =>
        Promise.resolve({
          errorCode: "STALE_VERSION",
          executionHandle: request.executionHandle,
          outcome: "rejected",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 5,
        }),
      )
      .mockImplementationOnce((request) =>
        Promise.resolve({
          errorCode: "STALE_VERSION",
          executionHandle: request.executionHandle,
          outcome: "rejected",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 6,
        }),
      );
    const selectedRepository = repository({
      ...candidate,
      cleanupStatus: "PENDING",
      executionStatus: "TERMINAL",
      terminalStatus: "COMPLETED",
    });
    const apply = vi.spyOn(selectedRepository, "applyControllerResponse");
    let randomByte = 1;

    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length).fill(randomByte++),
      }),
    ).resolves.toEqual({
      appliedCount: 2,
      deferredCount: 1,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    });
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ expectedVersion: 5 });
  });

  it("does not issue a fresh request when the stale-version D1 CAS loses", async () => {
    const mutate = vi
      .fn<(request: CloudRunControllerRequest) => Promise<CloudRunControllerResponse>>()
      .mockImplementation((request) =>
        Promise.resolve({
          errorCode: "STALE_VERSION",
          executionHandle: request.executionHandle,
          outcome: "rejected",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 5,
        }),
      );
    const selectedRepository = repository({
      ...candidate,
      cleanupStatus: "PENDING",
      executionStatus: "TERMINAL",
      terminalStatus: "COMPLETED",
    });
    const apply = vi.spyOn(selectedRepository, "applyControllerResponse").mockResolvedValue(false);

    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      appliedCount: 0,
      deferredCount: 1,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("fails a provider-terminal job without a runtime terminal before cleanup", async () => {
    const selectedRepository = repository({
      ...candidate,
      executionStatus: "TERMINAL",
      providerVersion: 5,
      terminalStatus: "COMPLETED",
    });
    const failMissingTerminal = vi.spyOn(selectedRepository, "failMissingTerminal");
    const createController = vi.fn();
    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createController,
        createRepository: () => selectedRepository,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      appliedCount: 0,
      deferredCount: 0,
      dispatch: "none",
      failedMissingTerminalCount: 1,
    });
    expect(failMissingTerminal).toHaveBeenCalledOnce();
    expect(createController).toHaveBeenCalledOnce();
  });

  it("defers a newly observed provider terminal while the runtime report can arrive", async () => {
    const selectedRepository = repository({
      ...candidate,
      executionStatus: "TERMINAL",
      executionUpdatedAt: NOW.toISOString(),
      providerVersion: 5,
      terminalStatus: "COMPLETED",
    });
    const failMissingTerminal = vi.spyOn(selectedRepository, "failMissingTerminal");
    const mutate = vi.fn();
    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      appliedCount: 0,
      deferredCount: 1,
      dispatch: "none",
      failedMissingTerminalCount: 0,
    });
    expect(failMissingTerminal).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("dispatches one pending Cloud Run job after reconciling the current batch", async () => {
    const selectedRepository = repository(candidate);
    vi.spyOn(selectedRepository, "findReconciliationCandidates").mockResolvedValue([]);
    vi.spyOn(selectedRepository, "findDispatchablePendingJobId").mockResolvedValue(candidate.jobId);
    const submitPendingJob = vi.fn().mockResolvedValue("accepted");
    await expect(
      reconcileCloudRunJobs(environment(), logger(), {
        createRepository: () => selectedRepository,
        submitPendingJob,
      }),
    ).resolves.toEqual({
      appliedCount: 0,
      deferredCount: 0,
      dispatch: "accepted",
      failedMissingTerminalCount: 0,
    });
    expect(submitPendingJob).toHaveBeenCalledWith(
      candidate.jobId,
      environment(),
      expect.anything(),
    );
  });
});
