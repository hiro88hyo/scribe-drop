import type { RunpodRunRequest } from "@scribe-drop/contracts";
import { describe, expect, it, vi } from "vitest";

import { createRunpodClient } from "./runpod-client.js";

const REQUEST = {
  input: {
    attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    claimToken: "t".repeat(43),
    jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    schemaVersion: 1,
  },
  policy: {
    executionTimeout: 21_600_000,
    ttl: 28_800_000,
  },
} satisfies RunpodRunRequest;

describe("RunPod client", () => {
  it("submits only the strict request and accepts a valid queue response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "runpod-job-id",
        status: "IN_QUEUE",
      }),
    );
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: fetchMock,
    });

    await expect(client.submit(REQUEST)).resolves.toEqual({
      outcome: "accepted",
      runpodJobId: "runpod-job-id",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.runpod.ai/v2/endpoint-id/run");
    expect(init?.headers).toMatchObject({
      accept: "application/json",
      "accept-encoding": "gzip",
      authorization: "Bearer runpod-api-key-placeholder",
      "content-type": "application/json",
    });
    expect(init?.redirect).toBe("manual");
    const serializedBody = init?.body;
    if (typeof serializedBody !== "string") {
      throw new Error("Expected a serialized JSON request");
    }
    expect(JSON.parse(serializedBody)).toEqual(REQUEST);
    expect(serializedBody).not.toContain("presigned");
    expect(serializedBody).not.toContain("webhook");
  });

  it("classifies an explicit HTTP failure as rejected", async () => {
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    });

    await expect(client.submit(REQUEST)).resolves.toEqual({ outcome: "rejected" });
  });

  it("does not follow a submission redirect", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { location: "https://example.invalid" }, status: 302 }),
      );
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: fetchMock,
    });

    await expect(client.submit(REQUEST)).resolves.toEqual({ outcome: "rejected" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it.each([
    ["timeout or connection failure", vi.fn<typeof fetch>().mockRejectedValue(new Error("failed"))],
    [
      "successful response without a usable job ID",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "IN_QUEUE" })),
    ],
  ])("classifies %s as outcome unknown", async (_name, fetchMock) => {
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: fetchMock,
    });

    await expect(client.submit(REQUEST)).resolves.toEqual({
      outcome: "unknown",
      reason: _name === "timeout or connection failure" ? "request_failed" : "response_invalid",
    });
  });

  it("validates status responses and calls the exact endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        delayTime: 100,
        error: "provider detail that must not reach the completion service",
        executionTime: 200,
        id: "runpod-job-id",
        input: REQUEST.input,
        output: {
          attemptId: REQUEST.input.attemptId,
          detectedLanguage: "ja",
          durationSeconds: 60,
          jobId: REQUEST.input.jobId,
          manifestWritten: true,
          schemaVersion: 1,
          segmentCount: 3,
          status: "completed",
        },
        status: "COMPLETED",
        workerId: "worker-id",
      }),
    );
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: fetchMock,
    });

    await expect(client.getStatus("runpod-job-id")).resolves.toEqual({
      outcome: "found",
      response: {
        delayTime: 100,
        executionTime: 200,
        id: "runpod-job-id",
        output: {
          attemptId: REQUEST.input.attemptId,
          detectedLanguage: "ja",
          durationSeconds: 60,
          jobId: REQUEST.input.jobId,
          manifestWritten: true,
          schemaVersion: 1,
          segmentCount: 3,
          status: "completed",
        },
        status: "COMPLETED",
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.runpod.ai/v2/endpoint-id/status/runpod-job-id",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip",
        authorization: "Bearer runpod-api-key-placeholder",
      },
      method: "GET",
      redirect: "manual",
    });
  });

  it.each([
    ["not found", new Response(null, { status: 404 }), "not_found"],
    [
      "unknown status",
      Response.json({ id: "runpod-job-id", status: "UNREVIEWED" }),
      "invalid_response",
    ],
    [
      "oversized response",
      new Response("{}", {
        headers: { "content-length": String(33 * 1024) },
        status: 200,
      }),
      "invalid_response",
    ],
    [
      "undeclared oversized response",
      new Response(
        JSON.stringify({
          id: "runpod-job-id",
          padding: "x".repeat(33 * 1024),
          status: "IN_PROGRESS",
        }),
      ),
      "invalid_response",
    ],
    ["rate limited", new Response(null, { status: 429 }), "unavailable"],
    [
      "redirect response",
      new Response(null, {
        headers: { location: "https://example.invalid" },
        status: 302,
      }),
      "unavailable",
    ],
  ])("classifies a %s status response", async (_name, response, outcome) => {
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-id",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    await expect(client.getStatus("runpod-job-id")).resolves.toEqual({ outcome });
  });

  it("classifies cancel responses without reading provider error bodies", async () => {
    const acceptedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const rejectedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("provider-secret-detail", { status: 403 }));

    await expect(
      createRunpodClient({
        apiKey: "runpod-api-key-placeholder",
        endpointId: "endpoint-id",
        fetch: acceptedFetch,
      }).cancel("runpod-job-id"),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      createRunpodClient({
        apiKey: "runpod-api-key-placeholder",
        endpointId: "endpoint-id",
        fetch: rejectedFetch,
      }).cancel("runpod-job-id"),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(acceptedFetch.mock.calls[0]?.[0]).toBe(
      "https://api.runpod.ai/v2/endpoint-id/cancel/runpod-job-id",
    );
    expect(acceptedFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip",
        authorization: "Bearer runpod-api-key-placeholder",
      },
      method: "POST",
      redirect: "manual",
    });
  });
});
