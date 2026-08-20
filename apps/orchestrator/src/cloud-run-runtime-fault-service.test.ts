import { cloudRunBootstrapRequestSchema, cloudRunClaimRequestSchema } from "@scribe-drop/contracts";
import { describe, expect, it, vi } from "vitest";

import fixture from "../../../packages/contracts/fixtures/cloud-run-runtime-v1.json";

import type { CloudRunRuntimeHttpService } from "./cloud-run-runtime-http.js";
import {
  createStagingAcceptanceRuntimeService,
  type RuntimeFaultTargetRepository,
} from "./cloud-run-runtime-fault-service.js";
import type { StagingAcceptanceFaultConfig } from "./staging-acceptance-fault.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = new Date("2026-08-14T01:15:00.000Z");
const bootstrapRequest = cloudRunBootstrapRequestSchema.parse(fixture.bootstrapRequest);
const claimRequest = cloudRunClaimRequestSchema.parse(fixture.claimRequest);

function config(fault: StagingAcceptanceFaultConfig["fault"]): StagingAcceptanceFaultConfig {
  return {
    appEnvironment: "staging",
    expiresAt: "2026-08-14T01:30:00.000Z",
    fault,
    issuedAt: "2026-08-14T01:00:00.000Z",
    jobId: JOB_ID,
  };
}

function service(): CloudRunRuntimeHttpService {
  return {
    acknowledge: vi.fn().mockResolvedValue({ acknowledged: true }),
    bootstrap: vi.fn().mockResolvedValue(fixture.bootstrapResponse),
    claim: vi.fn().mockResolvedValue(fixture.claimResponse),
    heartbeat: vi.fn().mockResolvedValue({ cancelRequested: true }),
    terminal: vi.fn().mockResolvedValue({ accepted: true, cleanupPending: true }),
  };
}

function repository(jobId: string | undefined = JOB_ID): RuntimeFaultTargetRepository {
  return { findJobId: vi.fn().mockResolvedValue(jobId) };
}

const ackRequest = {
  executionHandle: fixture.bootstrapRequest.executionHandle,
  sequence: 0,
  sessionId: fixture.claimResponse.session.sessionId,
  sessionToken: fixture.claimResponse.session.token,
  state: "ready" as const,
};
const heartbeatRequest = {
  executionHandle: fixture.bootstrapRequest.executionHandle,
  progress: "download" as const,
  sequence: 1,
  sessionId: fixture.claimResponse.session.sessionId,
  sessionToken: fixture.claimResponse.session.token,
};
const terminalRequest = {
  artifactCount: 1,
  durationSeconds: 1,
  errorCode: null,
  executionHandle: fixture.bootstrapRequest.executionHandle,
  manifestWritten: true,
  segmentCount: 1,
  sequence: 2,
  sessionId: fixture.claimResponse.session.sessionId,
  sessionToken: fixture.claimResponse.session.token,
  status: "succeeded" as const,
};

describe("staging acceptance runtime fault service", () => {
  it("loses the response only after the target heartbeat is authenticated and recorded", async () => {
    const underlying = service();
    const wrapped = createStagingAcceptanceRuntimeService(
      underlying,
      config("runtime_heartbeat_response_loss"),
      repository(),
      { now: () => NOW },
    );

    await expect(wrapped.acknowledge(ackRequest)).resolves.toEqual({ acknowledged: true });
    await expect(wrapped.heartbeat(heartbeatRequest)).rejects.toThrow(
      "Staging acceptance heartbeat response was lost",
    );
    expect(underlying.acknowledge).toHaveBeenCalledOnce();
    expect(underlying.heartbeat).toHaveBeenCalledOnce();
  });

  it("disconnects the target after claim while leaving bootstrap and claim reachable", async () => {
    const underlying = service();
    const wrapped = createStagingAcceptanceRuntimeService(
      underlying,
      config("worker_disconnect_after_claim"),
      repository(),
      { now: () => NOW },
    );

    await expect(wrapped.bootstrap(bootstrapRequest)).resolves.toEqual(fixture.bootstrapResponse);
    await expect(wrapped.claim(claimRequest)).resolves.toEqual(fixture.claimResponse);
    await expect(wrapped.acknowledge(ackRequest)).rejects.toThrow(
      "Staging acceptance runtime connection is unavailable",
    );
    await expect(wrapped.terminal(terminalRequest)).resolves.toEqual({
      accepted: true,
      cleanupPending: true,
    });
    expect(underlying.acknowledge).toHaveBeenCalledOnce();
    expect(underlying.terminal).toHaveBeenCalledOnce();
  });

  it("never changes a different job or an expired lease", async () => {
    const underlying = service();
    const differentJob = createStagingAcceptanceRuntimeService(
      underlying,
      config("runtime_heartbeat_response_loss"),
      repository("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      { now: () => NOW },
    );
    await expect(differentJob.heartbeat(heartbeatRequest)).resolves.toEqual({
      cancelRequested: true,
    });

    const expired = createStagingAcceptanceRuntimeService(
      underlying,
      config("runtime_heartbeat_response_loss"),
      repository(),
      { now: () => new Date("2026-08-14T01:30:00.000Z") },
    );
    await expect(expired.heartbeat(heartbeatRequest)).resolves.toEqual({
      cancelRequested: true,
    });
    expect(underlying.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("does not replace an authentication rejection with an injected response loss", async () => {
    const underlying = service();
    const rejection = new Error("session rejected");
    vi.mocked(underlying.heartbeat).mockRejectedValue(rejection);
    const findJobId = vi.fn<RuntimeFaultTargetRepository["findJobId"]>().mockResolvedValue(JOB_ID);
    const targetRepository = { findJobId };
    const wrapped = createStagingAcceptanceRuntimeService(
      underlying,
      config("runtime_heartbeat_response_loss"),
      targetRepository,
      { now: () => NOW },
    );

    await expect(wrapped.heartbeat(heartbeatRequest)).rejects.toBe(rejection);
    expect(findJobId).not.toHaveBeenCalled();
  });
});
