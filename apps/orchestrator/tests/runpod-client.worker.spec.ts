import type { RunpodRunRequest } from "@scribe-drop/contracts";
import { describe, expect, it, vi } from "vitest";

import { createRunpodClient } from "../src/runpod-client.js";

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

describe("RunPod client in the Workers runtime", () => {
  it("reads a valid queue response from a Workers response stream", async () => {
    const client = createRunpodClient({
      apiKey: "runpod-api-key-placeholder",
      endpointId: "endpoint-placeholder",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: "runpod-job-id",
          status: "IN_QUEUE",
        }),
      ),
    });

    await expect(client.submit(REQUEST)).resolves.toEqual({
      outcome: "accepted",
      runpodJobId: "runpod-job-id",
    });
  });
});
