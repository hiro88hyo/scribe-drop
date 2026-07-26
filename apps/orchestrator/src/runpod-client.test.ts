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

    await expect(client.submit(REQUEST)).resolves.toEqual({ outcome: "unknown" });
  });
});
