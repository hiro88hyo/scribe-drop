import type { CloudRunControllerRequest, CloudRunControllerResponse } from "@scribe-drop/contracts";
import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import {
  deriveCloudRunExecutionHandle,
  submitPendingCloudRunJob,
  type CloudRunSubmissionEnvironment,
} from "./cloud-run-submission-service.js";
import type { CloudRunControlRepository } from "./cloud-run-control-repository.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

function environment(): CloudRunSubmissionEnvironment {
  return {
    APP_ENV: "staging",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: SECRET,
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

function repository(): CloudRunControlRepository {
  return {
    applyControllerResponse: () => Promise.resolve(false),
    failMissingTerminal: () => Promise.resolve(false),
    findDispatchablePendingJobId: () => Promise.resolve(undefined),
    findReconciliationCandidates: () => Promise.resolve([]),
    findSubmissionCandidate: () =>
      Promise.resolve({ attemptId: ATTEMPT_ID, jobId: JOB_ID, submissionStartedAt: null }),
    prepareSubmission: ({ candidate, executionHandle, timestamp }) =>
      Promise.resolve({
        ...candidate,
        executionHandle,
        submissionStartedAt: timestamp,
      }),
    recordCreateResponse: () => Promise.resolve(true),
    recordCreateRejected: () => Promise.resolve(true),
    recordCreateUnknown: () => Promise.resolve(true),
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

describe("Cloud Run submission", () => {
  it("derives a stable opaque handle without exposing the attempt ID", async () => {
    const first = await deriveCloudRunExecutionHandle(ATTEMPT_ID);
    expect(first).toHaveLength(43);
    expect(first).not.toContain(ATTEMPT_ID);
    await expect(deriveCloudRunExecutionHandle(ATTEMPT_ID)).resolves.toBe(first);
  });

  it("replays the exact create request once after a lost response", async () => {
    const mutate = vi
      .fn<(request: CloudRunControllerRequest) => Promise<CloudRunControllerResponse>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementationOnce((request) =>
        Promise.resolve({
          errorCode: null,
          executionHandle: request.executionHandle,
          outcome: "pending",
          requestId: request.requestId,
          schemaVersion: 1,
          version: 3,
        }),
      );
    const selectedRepository = repository();
    const recordCreateResponse = vi.spyOn(selectedRepository, "recordCreateResponse");
    await expect(
      submitPendingCloudRunJob(JOB_ID, environment(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        logger: logger(),
        now: () => NOW,
      }),
    ).resolves.toBe("accepted");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0]?.[0]).toEqual(mutate.mock.calls[1]?.[0]);
    expect(recordCreateResponse).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: ATTEMPT_ID, jobId: JOB_ID }),
    );
  });

  it("persists unknown after exactly two unavailable responses", async () => {
    const mutate = vi.fn().mockRejectedValue(new Error("unavailable"));
    const selectedRepository = repository();
    const recordCreateUnknown = vi.spyOn(selectedRepository, "recordCreateUnknown");
    await expect(
      submitPendingCloudRunJob(JOB_ID, environment(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        logger: logger(),
        now: () => NOW,
      }),
    ).resolves.toBe("unknown");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(recordCreateUnknown).toHaveBeenCalledOnce();
  });

  it("persists a capacity rejection as terminal without scheduling cleanup", async () => {
    const mutate = vi.fn().mockResolvedValue({
      errorCode: "BUDGET_EXHAUSTED",
      executionHandle: await deriveCloudRunExecutionHandle(ATTEMPT_ID),
      outcome: "rejected",
      requestId: ATTEMPT_ID,
      schemaVersion: 1,
      version: 1,
    });
    const selectedRepository = repository();
    const recordCreateRejected = vi.spyOn(selectedRepository, "recordCreateRejected");
    await expect(
      submitPendingCloudRunJob(JOB_ID, environment(), {
        createController: () => ({ mutate }),
        createEventId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        createRepository: () => selectedRepository,
        logger: logger(),
        now: () => NOW,
      }),
    ).resolves.toBe("rejected");
    expect(recordCreateRejected).toHaveBeenCalledOnce();
  });

  it("keeps a conflicting create in unknown reconciliation instead of declaring cleanup", async () => {
    const mutate = vi.fn().mockResolvedValue({
      errorCode: "CONFLICT",
      executionHandle: await deriveCloudRunExecutionHandle(ATTEMPT_ID),
      outcome: "rejected",
      requestId: ATTEMPT_ID,
      schemaVersion: 1,
      version: 4,
    });
    const selectedRepository = repository();
    const recordCreateResponse = vi.spyOn(selectedRepository, "recordCreateResponse");
    const recordCreateRejected = vi.spyOn(selectedRepository, "recordCreateRejected");
    await expect(
      submitPendingCloudRunJob(JOB_ID, environment(), {
        createController: () => ({ mutate }),
        createRepository: () => selectedRepository,
        logger: logger(),
        now: () => NOW,
      }),
    ).resolves.toBe("unknown");
    expect(recordCreateResponse).toHaveBeenCalledOnce();
    expect(recordCreateRejected).not.toHaveBeenCalled();
  });
});
