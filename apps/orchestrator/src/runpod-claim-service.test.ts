import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import { hashCapabilityToken } from "./capability-token.js";
import type { R2CapabilityIssuer } from "./r2-capability-issuer.js";
import {
  claimRunpodExecution,
  recordRunpodHeartbeat,
  type RunpodClaimEnvironment,
} from "./runpod-claim-service.js";
import type { ClaimContext, RunpodControlRepository } from "./runpod-control-repository.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const CLAIM_TOKEN = "c".repeat(43);
const HEARTBEAT_TOKEN = "h".repeat(43);

function logger(): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: () => undefined,
  });
}

function environment(): RunpodClaimEnvironment {
  return {
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
    RUNPOD_INTERNAL_BASE_URL: "https://orchestrator.example.invalid",
    SCRIBE_DROP_DB: {} as D1Database,
  };
}

async function claimContext(overrides: Partial<ClaimContext> = {}): Promise<ClaimContext> {
  return {
    activeAttemptId: ATTEMPT_ID,
    actualSizeBytes: 1024,
    attemptId: ATTEMPT_ID,
    attemptStatus: "SUBMITTING",
    claimConsumedAt: null,
    claimExpiresAt: "2026-07-25T00:15:00.000Z",
    claimIssuedAt: NOW.toISOString(),
    claimTokenHash: await hashCapabilityToken(CLAIM_TOKEN),
    generation: 1,
    heartbeatExpiresAt: null,
    heartbeatIssuedAt: null,
    heartbeatRevokedAt: null,
    heartbeatTokenHash: null,
    jobId: JOB_ID,
    jobStatus: "SUBMITTING",
    resultPrefix: `results/owner/${JOB_ID}/${ATTEMPT_ID}/`,
    sourceBucket: "recording-transcriber-test",
    sourceEtag: "etag",
    sourceKey: `incoming/owner/${JOB_ID}/nonce/source.m4a`,
    winningRunpodJobId: null,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<RunpodControlRepository> = {}): RunpodControlRepository {
  return {
    cancelExpiredUnboundSubmission: () => Promise.resolve(false),
    claimWinner: () => Promise.resolve(false),
    findClaimContext: () => Promise.resolve(undefined),
    findDispatchablePendingJobId: () => Promise.resolve(undefined),
    findExpiredUnknownSubmissions: () => Promise.resolve([]),
    findExpiredUnboundCancellations: () => Promise.resolve([]),
    findFailedUnclaimedSubmissions: () => Promise.resolve([]),
    findStaleAcceptedSubmissions: () => Promise.resolve([]),
    failStaleAcceptedSubmission: () => Promise.resolve(false),
    failExpiredUnknownSubmission: () => Promise.resolve(false),
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

function issuer(): R2CapabilityIssuer {
  return {
    issue: () =>
      Promise.resolve({
        expiresAt: "2026-07-25T02:00:00.000Z",
        jsonPutUrl: "https://storage.example.invalid/transcript.json?signature=redacted",
        manifestPutUrl: "https://storage.example.invalid/manifest.json?signature=redacted",
        markdownPutUrl: "https://storage.example.invalid/transcript.md?signature=redacted",
        sourceGetUrl: "https://storage.example.invalid/source?signature=redacted",
        srtPutUrl: "https://storage.example.invalid/transcript.srt?signature=redacted",
      }),
  };
}

describe("RunPod claim service", () => {
  it("atomically selects a winner before issuing R2 and heartbeat capabilities", async () => {
    const context = await claimContext();
    const order: string[] = [];
    const claimWinner = vi.fn<RunpodControlRepository["claimWinner"]>(() => {
      order.push("claim");
      return Promise.resolve(true);
    });
    const capabilityIssuer: R2CapabilityIssuer = {
      issue: (request) => {
        order.push("issue");
        expect(request).toEqual({
          resultPrefix: context.resultPrefix,
          sourceBucket: context.sourceBucket,
          sourceKey: context.sourceKey,
        });
        return issuer().issue(request);
      },
    };

    const result = await claimRunpodExecution(
      {
        attemptId: ATTEMPT_ID,
        claimToken: CLAIM_TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      },
      environment(),
      {
        createEventId: () => EVENT_ID,
        createR2CapabilityIssuer: () => capabilityIssuer,
        createRepository: () =>
          fakeRepository({
            claimWinner,
            findClaimContext: () => Promise.resolve(context),
          }),
        logger: logger(),
        now: () => NOW,
        randomBytes: (length) => new Uint8Array(length),
      },
    );

    if (result.kind !== "granted") {
      throw new Error("Expected a granted claim");
    }
    expect(order).toEqual(["claim", "issue"]);
    expect(result.response).toMatchObject({
      expiresAt: "2026-07-25T02:00:00.000Z",
      granted: true,
      heartbeat: {
        url: "https://orchestrator.example.invalid/internal/runpod/heartbeat",
      },
      source: {
        expectedEtag: "etag",
        expectedSizeBytes: 1024,
      },
    });
    expect(result.response.heartbeat.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(result)).not.toContain(CLAIM_TOKEN);
  });

  it("rejects same-winner replay without reissuing capabilities", async () => {
    const context = await claimContext({
      attemptStatus: "RUNNING",
      claimConsumedAt: NOW.toISOString(),
      jobStatus: "RUNNING",
      winningRunpodJobId: "runpod-job-id",
    });
    const issue = vi.fn<R2CapabilityIssuer["issue"]>();

    const result = await claimRunpodExecution(
      {
        attemptId: ATTEMPT_ID,
        claimToken: CLAIM_TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      },
      environment(),
      {
        createR2CapabilityIssuer: () => ({ issue }),
        createRepository: () =>
          fakeRepository({ findClaimContext: () => Promise.resolve(context) }),
        logger: logger(),
        now: () => NOW,
      },
    );

    expect(result).toEqual({ kind: "rejected" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("records a different RunPod job as a loser and returns deduplication", async () => {
    const context = await claimContext({
      attemptStatus: "RUNNING",
      claimConsumedAt: NOW.toISOString(),
      jobStatus: "RUNNING",
      winningRunpodJobId: "winner-job-id",
    });
    const recordClaimSubmission = vi.fn<RunpodControlRepository["recordClaimSubmission"]>(() =>
      Promise.resolve(),
    );

    const result = await claimRunpodExecution(
      {
        attemptId: ATTEMPT_ID,
        claimToken: CLAIM_TOKEN,
        jobId: JOB_ID,
        runpodJobId: "loser-job-id",
      },
      environment(),
      {
        createRepository: () =>
          fakeRepository({
            findClaimContext: () => Promise.resolve(context),
            recordClaimSubmission,
          }),
        logger: logger(),
        now: () => NOW,
      },
    );

    expect(result).toEqual({
      kind: "deduplicated",
      response: { deduplicated: true },
    });
    expect(recordClaimSubmission).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      runpodJobId: "loser-job-id",
      timestamp: NOW.toISOString(),
    });
  });

  it.each([
    ["expired token", { claimExpiresAt: NOW.toISOString() }],
    ["stale attempt", { activeAttemptId: EVENT_ID }],
    ["cancel requested", { attemptStatus: "CANCEL_REQUESTED" as const }],
  ])("rejects %s before winner CAS", async (_name, overrides) => {
    const claimWinner = vi.fn<RunpodControlRepository["claimWinner"]>();
    const context = await claimContext(overrides);

    await expect(
      claimRunpodExecution(
        {
          attemptId: ATTEMPT_ID,
          claimToken: CLAIM_TOKEN,
          jobId: JOB_ID,
          runpodJobId: "runpod-job-id",
        },
        environment(),
        {
          createRepository: () =>
            fakeRepository({
              claimWinner,
              findClaimContext: () => Promise.resolve(context),
            }),
          logger: logger(),
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({ kind: "rejected" });
    expect(claimWinner).not.toHaveBeenCalled();
  });
});

describe("RunPod heartbeat service", () => {
  it("authenticates the winner and returns the cancellation state", async () => {
    const context = await claimContext({
      attemptStatus: "CANCEL_REQUESTED",
      claimConsumedAt: NOW.toISOString(),
      heartbeatExpiresAt: "2026-07-25T08:00:00.000Z",
      heartbeatIssuedAt: NOW.toISOString(),
      heartbeatTokenHash: await hashCapabilityToken(HEARTBEAT_TOKEN),
      jobStatus: "CANCEL_REQUESTED",
      winningRunpodJobId: "runpod-job-id",
    });
    const markHeartbeat = vi.fn<RunpodControlRepository["markHeartbeat"]>(() =>
      Promise.resolve(true),
    );

    const result = await recordRunpodHeartbeat(
      {
        attemptId: ATTEMPT_ID,
        heartbeatToken: HEARTBEAT_TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      },
      environment(),
      {
        createRepository: () =>
          fakeRepository({
            findClaimContext: () => Promise.resolve(context),
            markHeartbeat,
          }),
        logger: logger(),
        now: () => NOW,
      },
    );

    expect(result).toEqual({
      kind: "accepted",
      response: { cancelRequested: true },
    });
    expect(markHeartbeat).toHaveBeenCalledOnce();
  });

  it("rejects an invalid heartbeat token before updating D1", async () => {
    const context = await claimContext({
      attemptStatus: "RUNNING",
      claimConsumedAt: NOW.toISOString(),
      heartbeatExpiresAt: "2026-07-25T08:00:00.000Z",
      heartbeatIssuedAt: NOW.toISOString(),
      heartbeatTokenHash: await hashCapabilityToken(HEARTBEAT_TOKEN),
      jobStatus: "RUNNING",
      winningRunpodJobId: "runpod-job-id",
    });
    const markHeartbeat = vi.fn<RunpodControlRepository["markHeartbeat"]>();

    const result = await recordRunpodHeartbeat(
      {
        attemptId: ATTEMPT_ID,
        heartbeatToken: "x".repeat(43),
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      },
      environment(),
      {
        createRepository: () =>
          fakeRepository({
            findClaimContext: () => Promise.resolve(context),
            markHeartbeat,
          }),
        logger: logger(),
        now: () => NOW,
      },
    );

    expect(result).toEqual({ kind: "rejected" });
    expect(markHeartbeat).not.toHaveBeenCalled();
  });
});
