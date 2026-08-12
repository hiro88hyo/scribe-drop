import { describe, expect, it, vi } from "vitest";

import {
  createRunpodPlacementVerifier,
  type RunpodPlacementVerifierOptions,
} from "./runpod-placement-verifier.js";

const API_KEY = "runpod-api-key-placeholder";
const ENDPOINT_ID = "endpoint-placeholder";
const EXPECTED_IMAGE = "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64);
const RUNPOD_JOB_ID = "runpod-job-id";
const WORKER_ID = "worker-id";

function statusResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return Response.json({
    id: RUNPOD_JOB_ID,
    status: "IN_PROGRESS",
    workerId: WORKER_ID,
    ...overrides,
  });
}

function podResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return Response.json({
    desiredStatus: "RUNNING",
    endpointId: ENDPOINT_ID,
    id: WORKER_ID,
    image: EXPECTED_IMAGE,
    machine: {
      gpuTypeId: "NVIDIA GeForce RTX 5090",
      secureCloud: true,
    },
    ...overrides,
  });
}

function options(fetchImplementation: typeof fetch): RunpodPlacementVerifierOptions {
  return {
    allowedGpuTypeIds: [
      "NVIDIA GeForce RTX 5090",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    ],
    apiKey: API_KEY,
    endpointId: ENDPOINT_ID,
    expectedImage: EXPECTED_IMAGE,
    fetch: fetchImplementation,
  };
}

describe("RunPod placement verifier", () => {
  it("verifies a job only when its active worker has the exact reviewed placement", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(podResponse());

    const result = await createRunpodPlacementVerifier(options(fetchImplementation)).verify(
      RUNPOD_JOB_ID,
    );

    expect(result).toEqual({ outcome: "verified" });
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      `https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${RUNPOD_JOB_ID}`,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      `https://rest.runpod.io/v1/pods/${WORKER_ID}?includeMachine=true&includeWorkers=true`,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
    for (const call of fetchImplementation.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        accept: "application/json",
        authorization: `Bearer ${API_KEY}`,
      });
    }
  });

  it("accepts the Pod API imageName field when it is the exact immutable image", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(
        podResponse({
          image: undefined,
          imageName: EXPECTED_IMAGE,
        }),
      );

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "verified" });
  });

  it.each([
    ["job is not executing", statusResponse({ status: "IN_QUEUE" })],
    ["job ID differs", statusResponse({ id: "other-job-id" })],
    ["worker ID is absent", statusResponse({ workerId: undefined })],
  ])("rejects before Pod lookup when %s", async (_name, response) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "rejected" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    ["worker ID differs", podResponse({ id: "other-worker-id" })],
    ["endpoint differs", podResponse({ endpointId: "other-endpoint" })],
    ["worker is not running", podResponse({ desiredStatus: "EXITED" })],
    ["image differs", podResponse({ image: EXPECTED_IMAGE.replace(/a$/u, "b") })],
    [
      "GPU is not allowed",
      podResponse({
        machine: {
          gpuTypeId: "NVIDIA L4",
          secureCloud: true,
        },
      }),
    ],
    [
      "machine is in Community Cloud",
      podResponse({
        machine: {
          gpuTypeId: "NVIDIA GeForce RTX 5090",
          secureCloud: false,
        },
      }),
    ],
  ])("rejects when %s", async (_name, response) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(response);

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "rejected" });
  });

  it.each([
    ["status request fails", [() => Promise.reject(new Error("network failure"))]],
    ["status response is malformed", [() => Promise.resolve(Response.json({}))]],
    [
      "Pod request fails",
      [() => Promise.resolve(statusResponse()), () => Promise.reject(new Error("network failure"))],
    ],
    [
      "Pod response is malformed",
      [() => Promise.resolve(statusResponse()), () => Promise.resolve(Response.json({}))],
    ],
  ])("reports unavailable when %s", async (_name, responses) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    for (const response of responses) {
      fetchImplementation.mockImplementationOnce(response);
    }

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("never follows redirects to a different origin", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        headers: { location: "https://attacker.invalid" },
        status: 302,
      }),
    );

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects an oversized provider response without reading its body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: { "content-length": String(32 * 1024 + 1) },
      }),
    );

    await expect(
      createRunpodPlacementVerifier(options(fetchImplementation)).verify(RUNPOD_JOB_ID),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
