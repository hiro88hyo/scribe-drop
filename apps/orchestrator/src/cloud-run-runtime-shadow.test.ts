import { describe, expect, it, vi } from "vitest";

import fixture from "../../../packages/contracts/fixtures/cloud-run-runtime-v1.json";

import type { CloudRunRuntimeHttpService } from "./cloud-run-runtime-http.js";
import { handleCloudRunRuntimeShadowRequest } from "./cloud-run-runtime-shadow.js";

function request(path = "/internal/cloud-run/bootstrap"): Request {
  return new Request(`https://orchestrator.example.invalid${path}`, {
    body: JSON.stringify(fixture.bootstrapRequest),
    headers: { "content-type": "application/json" },
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

describe("Cloud Run synthetic shadow route", () => {
  it("leaves unrelated requests for the existing RunPod handler", async () => {
    await expect(
      handleCloudRunRuntimeShadowRequest(request("/internal/runpod/claim"), {
        APP_ENV: "staging",
        CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{ APP_ENV: "local" }],
    [{ APP_ENV: "staging" }],
    [{ APP_ENV: "production", CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow" }],
    [{ APP_ENV: "staging", CLOUD_RUN_RUNTIME_MODE: "enabled" }],
  ])("returns an indistinguishable 404 unless the exact staging mode is enabled", async (env) => {
    const service = fakeService();
    const response = await handleCloudRunRuntimeShadowRequest(request(), env, service);
    expect(response?.status).toBe(404);
    expect(service.bootstrap).not.toHaveBeenCalled();
  });

  it("fails closed when configuration is enabled before production ports are injected", async () => {
    const response = await handleCloudRunRuntimeShadowRequest(request(), {
      APP_ENV: "staging",
      CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
    });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("dispatches only after staging mode and service injection agree", async () => {
    const service = fakeService();
    const response = await handleCloudRunRuntimeShadowRequest(
      request(),
      { APP_ENV: "staging", CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow" },
      service,
    );
    expect(response?.status).toBe(200);
    expect(service.bootstrap).toHaveBeenCalledOnce();
  });
});
