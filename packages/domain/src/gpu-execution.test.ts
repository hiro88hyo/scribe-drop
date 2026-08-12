import { describe, expect, it } from "vitest";

import {
  GPU_CLEANUP_STATUSES,
  GPU_EXECUTION_POLICIES,
  GPU_EXECUTION_PROVIDER_KINDS,
  GPU_EXECUTION_STATUSES,
  canTransitionGpuCleanupStatus,
  canTransitionGpuExecutionStatus,
  getGpuProviderErrorDescriptor,
} from "./gpu-execution.js";

describe("provider-neutral GPU execution", () => {
  it("exposes selected providers without changing the lifecycle contract", () => {
    expect(GPU_EXECUTION_PROVIDER_KINDS).toEqual(["runpod_serverless", "cloud_run_jobs"]);
    expect(GPU_EXECUTION_POLICIES).toEqual(["runpod_serverless_v1", "cloud_run_jobs_l4_v1"]);
  });

  it("allows only explicit lifecycle transitions", () => {
    const allowed = GPU_EXECUTION_STATUSES.flatMap((from) =>
      GPU_EXECUTION_STATUSES.filter((to) => canTransitionGpuExecutionStatus(from, to)).map(
        (to) => `${from}->${to}`,
      ),
    );

    expect(allowed).toEqual([
      "PENDING->CREATING",
      "PENDING->CANCEL_REQUESTED",
      "PENDING->TERMINAL",
      "CREATING->RUNNING",
      "CREATING->CANCEL_REQUESTED",
      "CREATING->TERMINAL",
      "RUNNING->CANCEL_REQUESTED",
      "RUNNING->TERMINAL",
      "CANCEL_REQUESTED->TERMINAL",
    ]);
  });

  it("allows cleanup retries without reopening execution", () => {
    const allowed = GPU_CLEANUP_STATUSES.flatMap((from) =>
      GPU_CLEANUP_STATUSES.filter((to) => canTransitionGpuCleanupStatus(from, to)).map(
        (to) => `${from}->${to}`,
      ),
    );

    expect(allowed).toEqual([
      "NOT_REQUESTED->PENDING",
      "PENDING->IN_PROGRESS",
      "IN_PROGRESS->SUCCEEDED",
      "IN_PROGRESS->FAILED",
      "FAILED->PENDING",
    ]);
  });

  it("never retries an unknown create outcome", () => {
    expect(getGpuProviderErrorDescriptor("unknown_outcome")).toEqual({
      outcomeKnown: false,
      retryable: false,
    });
    expect(getGpuProviderErrorDescriptor("retryable")).toEqual({
      outcomeKnown: true,
      retryable: true,
    });
  });
});
