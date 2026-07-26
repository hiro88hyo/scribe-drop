import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type { PreparedSubmission, RunpodControlRepository } from "./runpod-control-repository.js";
import type { RunpodSubmissionClient } from "./runpod-client.js";
import { CLAIM_TOKEN_TTL_MS, submitPendingRunpodJob } from "./runpod-submission-service.js";
import type { RunpodSubmissionEnvironment } from "./runpod-submission-service.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PREPARED: PreparedSubmission = {
  attemptId: ATTEMPT_ID,
  generation: 1,
  jobId: JOB_ID,
};

function fakeRepository(overrides: Partial<RunpodControlRepository> = {}): RunpodControlRepository {
  return {
    cancelExpiredUnboundSubmission: () => Promise.resolve(false),
    claimWinner: () => Promise.resolve(false),
    findClaimContext: () => Promise.resolve(undefined),
    findDispatchablePendingJobId: () => Promise.resolve(undefined),
    findExpiredUnknownSubmissions: () => Promise.resolve([]),
    findExpiredUnboundCancellations: () => Promise.resolve([]),
    failExpiredUnknownSubmission: () => Promise.resolve(false),
    markHeartbeat: () => Promise.resolve(false),
    prepareSubmission: () => Promise.resolve(PREPARED),
    recordClaimSubmission: () => Promise.resolve(),
    recordSubmissionAccepted: () => Promise.resolve(true),
    recordSubmissionRejected: () => Promise.resolve(true),
    recordSubmissionUnknown: () => Promise.resolve(true),
    ...overrides,
  };
}

function environment(): RunpodSubmissionEnvironment {
  return {
    RUNPOD_API_KEY: "runpod-api-key-placeholder",
    RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
    SCRIBE_DROP_DB: {} as D1Database,
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

describe("RunPod submission service", () => {
  it("issues a short claim and submits only the minimal pinned request", async () => {
    const records: string[] = [];
    const prepareSubmission = vi.fn<RunpodControlRepository["prepareSubmission"]>(() =>
      Promise.resolve(PREPARED),
    );
    const recordSubmissionAccepted = vi.fn<RunpodControlRepository["recordSubmissionAccepted"]>(
      () => Promise.resolve(true),
    );
    const submit = vi.fn<RunpodSubmissionClient["submit"]>(() =>
      Promise.resolve({ outcome: "accepted", runpodJobId: "runpod-job-id" }),
    );

    await expect(
      submitPendingRunpodJob(JOB_ID, environment(), {
        createRepository: () => fakeRepository({ prepareSubmission, recordSubmissionAccepted }),
        createRunpodClient: () => ({ submit }),
        logger: testLogger(records),
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length),
      }),
    ).resolves.toBe("accepted");

    const preparedInput = prepareSubmission.mock.calls[0]?.[0];
    expect(preparedInput).toEqual({
      claimExpiresAt: new Date(NOW.getTime() + CLAIM_TOKEN_TTL_MS).toISOString(),
      claimTokenHash: preparedInput?.claimTokenHash,
      jobId: JOB_ID,
      timestamp: NOW.toISOString(),
    });
    expect(preparedInput?.claimTokenHash).toMatch(/^[0-9a-f]{64}$/u);
    const submittedRequest = submit.mock.calls[0]?.[0];
    expect(submittedRequest).toEqual({
      input: {
        attemptId: ATTEMPT_ID,
        claimToken: submittedRequest?.input.claimToken,
        jobId: JOB_ID,
        schemaVersion: 1,
      },
      policy: {
        executionTimeout: 21_600_000,
        ttl: 28_800_000,
      },
    });
    expect(submittedRequest?.input.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const serialized = records.join("\n");
    expect(serialized).not.toContain("claimToken");
    expect(serialized).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("does not call RunPod while another attempt owns the submission gate", async () => {
    const submit = vi.fn<RunpodSubmissionClient["submit"]>();

    await expect(
      submitPendingRunpodJob(JOB_ID, environment(), {
        createRepository: () =>
          fakeRepository({ prepareSubmission: () => Promise.resolve(undefined) }),
        createRunpodClient: () => ({ submit }),
        logger: testLogger([]),
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length),
      }),
    ).resolves.toBe("deferred");
    expect(submit).not.toHaveBeenCalled();
  });

  it("marks an accepted response unknown when its submission ID cannot be persisted", async () => {
    const records: string[] = [];
    const recordSubmissionUnknown = vi.fn<RunpodControlRepository["recordSubmissionUnknown"]>(() =>
      Promise.resolve(true),
    );

    await expect(
      submitPendingRunpodJob(JOB_ID, environment(), {
        createRepository: () =>
          fakeRepository({
            recordSubmissionAccepted: () => Promise.resolve(false),
            recordSubmissionUnknown,
          }),
        createRunpodClient: () => ({
          submit: () => Promise.resolve({ outcome: "accepted", runpodJobId: "runpod-job-id" }),
        }),
        logger: testLogger(records),
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length),
      }),
    ).resolves.toBe("unknown");

    expect(recordSubmissionUnknown).toHaveBeenCalledWith(ATTEMPT_ID, NOW.toISOString());
    expect(records.join("\n")).toContain('"errorCode":"RUNPOD_PERSISTENCE_CONFLICT"');
  });

  it.each(["unknown", "rejected"] as const)("persists the distinct %s outcome", async (outcome) => {
    const records: string[] = [];
    const recordSubmissionUnknown = vi.fn<RunpodControlRepository["recordSubmissionUnknown"]>(() =>
      Promise.resolve(true),
    );
    const recordSubmissionRejected = vi.fn<RunpodControlRepository["recordSubmissionRejected"]>(
      () => Promise.resolve(true),
    );

    await expect(
      submitPendingRunpodJob(JOB_ID, environment(), {
        createEventId: () => EVENT_ID,
        createRepository: () =>
          fakeRepository({ recordSubmissionRejected, recordSubmissionUnknown }),
        createRunpodClient: () => ({
          submit: () =>
            Promise.resolve(
              outcome === "unknown" ? { outcome, reason: "response_invalid" } : { outcome },
            ),
        }),
        logger: testLogger(records),
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length),
      }),
    ).resolves.toBe(outcome);

    if (outcome === "unknown") {
      expect(recordSubmissionUnknown).toHaveBeenCalledWith(ATTEMPT_ID, NOW.toISOString());
      expect(recordSubmissionRejected).not.toHaveBeenCalled();
      expect(records.join("\n")).toContain('"errorCode":"RUNPOD_RESPONSE_INVALID"');
    } else {
      expect(recordSubmissionRejected).toHaveBeenCalledWith({
        attemptId: ATTEMPT_ID,
        eventId: EVENT_ID,
        jobId: JOB_ID,
        timestamp: NOW.toISOString(),
      });
      expect(recordSubmissionUnknown).not.toHaveBeenCalled();
    }
  });
});
