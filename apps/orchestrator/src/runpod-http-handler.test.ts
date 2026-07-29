import { describe, expect, it, vi } from "vitest";

import { handleRunpodHttpRequest, type RunpodHttpEnvironment } from "./runpod-http-handler.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TOKEN = "t".repeat(43);

function environment(): RunpodHttpEnvironment {
  return {
    APP_ENV: "local",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
    R2_BUCKET_NAME: "recording-transcriber-test",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
    RUNPOD_ALLOWED_GPU_IDS: "NVIDIA A40,NVIDIA L4",
    RUNPOD_API_KEY: "runpod-api-key-placeholder",
    RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
    RUNPOD_INTERNAL_BASE_URL: "https://orchestrator.example.invalid",
    RUNPOD_WORKER_IMAGE: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64),
    SCRIBE_DROP_DB: {} as D1Database,
  };
}

function post(path: string, body: unknown, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  return new Request(`http://localhost${path}`, {
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
  });
}

describe("RunPod internal HTTP boundary", () => {
  it("validates and dispatches a strict claim request", async () => {
    const claim = vi.fn().mockResolvedValue({
      kind: "deduplicated",
      response: { deduplicated: true },
    });

    const response = await handleRunpodHttpRequest(
      post("/internal/runpod/claim", {
        attemptId: ATTEMPT_ID,
        claimToken: TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      }),
      environment(),
      { claim },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deduplicated: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(claim).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "unknown field",
      {
        attemptId: ATTEMPT_ID,
        claimToken: TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
        sourceUrl: "https://must-not-be-accepted.example.invalid",
      },
      { "content-type": "application/json" },
    ],
    [
      "wrong content type",
      {
        attemptId: ATTEMPT_ID,
        claimToken: TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      },
      { "content-type": "text/plain" },
    ],
  ])("rejects %s without invoking the claim service", async (_name, body, headers) => {
    const claim = vi.fn();
    const response = await handleRunpodHttpRequest(
      post("/internal/runpod/claim", body, headers),
      environment(),
      { claim },
    );

    expect(response.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
  });

  it("normalizes a rejected heartbeat without exposing token or state", async () => {
    const response = await handleRunpodHttpRequest(
      post("/internal/runpod/heartbeat", {
        attemptId: ATTEMPT_ID,
        heartbeatToken: TOKEN,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-id",
      }),
      environment(),
      {
        heartbeat: vi.fn().mockResolvedValue({ kind: "rejected" }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "HEARTBEAT_REJECTED",
        message: "Heartbeat was rejected.",
      },
    });
  });

  it("fails closed when a production internal origin is not HTTPS", async () => {
    const response = await handleRunpodHttpRequest(post("/internal/runpod/claim", {}), {
      ...environment(),
      APP_ENV: "production",
      RUNPOD_INTERNAL_BASE_URL: "http://localhost:8787",
    });

    expect(response.status).toBe(500);
  });
});
