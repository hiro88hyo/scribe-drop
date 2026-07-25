export const JOB_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "SUBMISSION_PENDING",
  "SUBMITTING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "SOURCE_MUTATED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  "SUBMISSION_PENDING",
  "SUBMITTING",
  "RUNNING",
  "CANCEL_REQUESTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  CANCELLED: [],
  CANCEL_REQUESTED: ["CANCELLED", "COMPLETED", "FAILED", "SOURCE_MUTATED"],
  COMPLETED: [],
  CREATED: ["UPLOADING", "UPLOADED", "CANCELLED", "EXPIRED", "FAILED", "SOURCE_MUTATED"],
  EXPIRED: [],
  FAILED: ["SUBMISSION_PENDING"],
  RUNNING: ["CANCEL_REQUESTED", "COMPLETED", "FAILED", "SOURCE_MUTATED"],
  SOURCE_MUTATED: [],
  SUBMISSION_PENDING: ["SUBMITTING", "CANCEL_REQUESTED", "FAILED", "SOURCE_MUTATED"],
  SUBMITTING: ["RUNNING", "CANCEL_REQUESTED", "FAILED", "SOURCE_MUTATED"],
  UPLOADED: ["SUBMISSION_PENDING", "CANCEL_REQUESTED", "FAILED", "SOURCE_MUTATED"],
  UPLOADING: ["UPLOADED", "CANCELLED", "EXPIRED", "FAILED", "SOURCE_MUTATED"],
};

export const ATTEMPT_STATUS_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> =
  {
    CANCELLED: [],
    CANCEL_REQUESTED: ["CANCELLED", "COMPLETED", "FAILED"],
    COMPLETED: [],
    FAILED: [],
    RUNNING: ["CANCEL_REQUESTED", "COMPLETED", "FAILED"],
    SUBMISSION_PENDING: ["SUBMITTING", "CANCEL_REQUESTED", "FAILED"],
    SUBMITTING: ["RUNNING", "CANCEL_REQUESTED", "FAILED"],
  };

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "CANCELLED",
  "COMPLETED",
  "EXPIRED",
  "SOURCE_MUTATED",
]);

const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "CANCELLED",
  "COMPLETED",
  "FAILED",
]);

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionAttemptStatus(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_STATUS_TRANSITIONS[from].includes(to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status);
}

export function canRetryJob(status: JobStatus): boolean {
  return status === "FAILED";
}
