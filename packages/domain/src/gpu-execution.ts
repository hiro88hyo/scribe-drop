export const GPU_EXECUTION_PROVIDER_KINDS = ["runpod_serverless", "cloud_run_jobs"] as const;

export type GpuExecutionProviderKind = (typeof GPU_EXECUTION_PROVIDER_KINDS)[number];

export const GPU_EXECUTION_POLICIES = ["runpod_serverless_v1", "cloud_run_jobs_l4_v1"] as const;

export type GpuExecutionPolicy = (typeof GPU_EXECUTION_POLICIES)[number];

export const GPU_EXECUTION_STATUSES = [
  "PENDING",
  "CREATING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "TERMINAL",
] as const;

export type GpuExecutionStatus = (typeof GPU_EXECUTION_STATUSES)[number];

export const GPU_EXECUTION_STATUS_TRANSITIONS: Readonly<
  Record<GpuExecutionStatus, readonly GpuExecutionStatus[]>
> = {
  CANCEL_REQUESTED: ["TERMINAL"],
  CREATING: ["RUNNING", "CANCEL_REQUESTED", "TERMINAL"],
  PENDING: ["CREATING", "CANCEL_REQUESTED", "TERMINAL"],
  RUNNING: ["CANCEL_REQUESTED", "TERMINAL"],
  TERMINAL: [],
};

export const GPU_CLEANUP_STATUSES = [
  "NOT_REQUESTED",
  "PENDING",
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
] as const;

export type GpuCleanupStatus = (typeof GPU_CLEANUP_STATUSES)[number];

export const GPU_CLEANUP_STATUS_TRANSITIONS: Readonly<
  Record<GpuCleanupStatus, readonly GpuCleanupStatus[]>
> = {
  FAILED: ["PENDING"],
  IN_PROGRESS: ["SUCCEEDED", "FAILED"],
  NOT_REQUESTED: ["PENDING"],
  PENDING: ["IN_PROGRESS"],
  SUCCEEDED: [],
};

export const GPU_PROVIDER_ERROR_KINDS = [
  "cancelled",
  "conflict",
  "permanent",
  "retryable",
  "unknown_outcome",
] as const;

export type GpuProviderErrorKind = (typeof GPU_PROVIDER_ERROR_KINDS)[number];

export interface GpuProviderErrorDescriptor {
  readonly outcomeKnown: boolean;
  readonly retryable: boolean;
}

export const GPU_PROVIDER_ERROR_DESCRIPTORS: Readonly<
  Record<GpuProviderErrorKind, GpuProviderErrorDescriptor>
> = {
  cancelled: { outcomeKnown: true, retryable: false },
  conflict: { outcomeKnown: true, retryable: false },
  permanent: { outcomeKnown: true, retryable: false },
  retryable: { outcomeKnown: true, retryable: true },
  unknown_outcome: { outcomeKnown: false, retryable: false },
};

export interface GpuExecutionCreateRequest {
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly policy: GpuExecutionPolicy;
}

export type GpuExecutionCreateResult =
  | { readonly outcome: "accepted"; readonly providerHandle: string }
  | {
      readonly outcome: "rejected";
      readonly errorKind: Exclude<GpuProviderErrorKind, "unknown_outcome">;
    }
  | { readonly outcome: "unknown"; readonly errorKind: "unknown_outcome" };

export interface GpuExecutionObservation {
  readonly providerHandle: string;
  readonly status: "cancelled" | "failed" | "pending" | "running" | "succeeded";
}

export interface GpuExecutionProvider {
  cancel(providerHandle: string): Promise<void>;
  cleanup(providerHandle: string): Promise<void>;
  create(request: GpuExecutionCreateRequest): Promise<GpuExecutionCreateResult>;
  observe(providerHandle: string): Promise<GpuExecutionObservation>;
  readonly kind: GpuExecutionProviderKind;
}

export function canTransitionGpuExecutionStatus(
  from: GpuExecutionStatus,
  to: GpuExecutionStatus,
): boolean {
  return GPU_EXECUTION_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionGpuCleanupStatus(
  from: GpuCleanupStatus,
  to: GpuCleanupStatus,
): boolean {
  return GPU_CLEANUP_STATUS_TRANSITIONS[from].includes(to);
}

export function getGpuProviderErrorDescriptor(
  kind: GpuProviderErrorKind,
): GpuProviderErrorDescriptor {
  return GPU_PROVIDER_ERROR_DESCRIPTORS[kind];
}
