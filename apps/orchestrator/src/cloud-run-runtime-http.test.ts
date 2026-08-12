import { describe, expect, it, vi } from "vitest";

import fixture from "../../../packages/contracts/fixtures/cloud-run-runtime-v1.json";

import {
  handleCloudRunRuntimeRequest,
  type CloudRunRuntimeHttpService,
} from "./cloud-run-runtime-http.js";
import { CloudRunRuntimeError } from "./cloud-run-runtime-service.js";

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  const selectedHeaders = new Headers(headers);
  if (!selectedHeaders.has("content-type")) selectedHeaders.set("content-type", "application/json");
  return new Request(`https://orchestrator.example.invalid${path}`, {
    body: JSON.stringify(body),
    headers: selectedHeaders,
    method: "POST",
  });
}

function fakeService(): CloudRunRuntimeHttpService {
  return {
    acknowledge: vi.fn().mockResolvedValue({ acknowledged: true }),
    bootstrap: vi.fn().mockResolvedValue(fixture.bootstrapResponse),
    claim: vi.fn().mockResolvedValue(fixture.claimResponse),
    heartbeat: vi.fn().mockResolvedValue({ cancelRequested: false }),
    terminal: vi.fn().mockResolvedValue({ accepted: true, cleanupPending: true }),
  };
}

describe("Cloud Run runtime HTTP boundary", () => {
  it.each([
    ["bootstrap", fixture.bootstrapRequest],
    ["claim", fixture.claimRequest],
    [
      "ack",
      {
        executionHandle: fixture.bootstrapRequest.executionHandle,
        sequence: 0,
        sessionId: fixture.claimResponse.session.sessionId,
        sessionToken: fixture.claimResponse.session.token,
        state: "ready",
      },
    ],
    [
      "heartbeat",
      {
        executionHandle: fixture.bootstrapRequest.executionHandle,
        progress: "download",
        sequence: 1,
        sessionId: fixture.claimResponse.session.sessionId,
        sessionToken: fixture.claimResponse.session.token,
      },
    ],
    [
      "terminal",
      {
        artifactCount: 2,
        durationSeconds: 60,
        errorCode: null,
        executionHandle: fixture.bootstrapRequest.executionHandle,
        manifestWritten: true,
        segmentCount: 4,
        sequence: 2,
        sessionId: fixture.claimResponse.session.sessionId,
        sessionToken: fixture.claimResponse.session.token,
        status: "succeeded",
      },
    ],
  ])("strictly dispatches %s", async (endpoint, body) => {
    const response = await handleCloudRunRuntimeRequest(
      post(`/internal/cloud-run/${endpoint}`, body),
      fakeService(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unknown fields and oversized bodies before service dispatch", async () => {
    const service = fakeService();
    const unknown = await handleCloudRunRuntimeRequest(
      post("/internal/cloud-run/bootstrap", {
        ...fixture.bootstrapRequest,
        sourceUrl: "https://must-not-pass.example.invalid",
      }),
      service,
    );
    const oversized = await handleCloudRunRuntimeRequest(
      post("/internal/cloud-run/bootstrap", fixture.bootstrapRequest, {
        "content-length": "20000",
      }),
      service,
    );
    expect(unknown.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("normalizes authorization failures without echoing identity or capability values", async () => {
    const service = fakeService();
    vi.mocked(service.bootstrap).mockRejectedValue(new CloudRunRuntimeError("RESOURCE_DRIFT"));
    const response = await handleCloudRunRuntimeRequest(
      post("/internal/cloud-run/bootstrap", fixture.bootstrapRequest),
      service,
    );
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(403);
    expect(serialized).not.toContain(fixture.bootstrapRequest.identityToken);
    expect(serialized).not.toContain(fixture.bootstrapRequest.executionHandle);
  });

  it("does not route methods, queries, or unknown paths", async () => {
    const service = fakeService();
    const query = await handleCloudRunRuntimeRequest(
      post("/internal/cloud-run/heartbeat?debug=1", {}),
      service,
    );
    const unknown = await handleCloudRunRuntimeRequest(
      post("/internal/cloud-run/unknown", {}),
      service,
    );
    expect(query.status).toBe(404);
    expect(unknown.status).toBe(404);
  });
});
