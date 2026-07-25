import { describe, expect, it } from "vitest";

import {
  ATTEMPT_STATUSES,
  JOB_STATUSES,
  canRetryJob,
  canTransitionAttemptStatus,
  canTransitionJobStatus,
  isTerminalAttemptStatus,
  isTerminalJobStatus,
  type AttemptStatus,
  type JobStatus,
} from "./index.js";

const ALLOWED_JOB_TRANSITIONS = new Set([
  "CREATED->UPLOADING",
  "CREATED->UPLOADED",
  "CREATED->CANCELLED",
  "CREATED->EXPIRED",
  "CREATED->FAILED",
  "CREATED->SOURCE_MUTATED",
  "UPLOADING->UPLOADED",
  "UPLOADING->CANCELLED",
  "UPLOADING->EXPIRED",
  "UPLOADING->FAILED",
  "UPLOADING->SOURCE_MUTATED",
  "UPLOADED->SUBMISSION_PENDING",
  "UPLOADED->CANCEL_REQUESTED",
  "UPLOADED->FAILED",
  "UPLOADED->SOURCE_MUTATED",
  "SUBMISSION_PENDING->SUBMITTING",
  "SUBMISSION_PENDING->CANCEL_REQUESTED",
  "SUBMISSION_PENDING->FAILED",
  "SUBMISSION_PENDING->SOURCE_MUTATED",
  "SUBMITTING->RUNNING",
  "SUBMITTING->CANCEL_REQUESTED",
  "SUBMITTING->FAILED",
  "SUBMITTING->SOURCE_MUTATED",
  "RUNNING->CANCEL_REQUESTED",
  "RUNNING->COMPLETED",
  "RUNNING->FAILED",
  "RUNNING->SOURCE_MUTATED",
  "CANCEL_REQUESTED->CANCELLED",
  "CANCEL_REQUESTED->COMPLETED",
  "CANCEL_REQUESTED->FAILED",
  "CANCEL_REQUESTED->SOURCE_MUTATED",
  "FAILED->SUBMISSION_PENDING",
]);

const ALLOWED_ATTEMPT_TRANSITIONS = new Set([
  "SUBMISSION_PENDING->SUBMITTING",
  "SUBMISSION_PENDING->CANCEL_REQUESTED",
  "SUBMISSION_PENDING->FAILED",
  "SUBMITTING->RUNNING",
  "SUBMITTING->CANCEL_REQUESTED",
  "SUBMITTING->FAILED",
  "RUNNING->CANCEL_REQUESTED",
  "RUNNING->COMPLETED",
  "RUNNING->FAILED",
  "CANCEL_REQUESTED->CANCELLED",
  "CANCEL_REQUESTED->COMPLETED",
  "CANCEL_REQUESTED->FAILED",
]);

function transitionKey(from: JobStatus | AttemptStatus, to: JobStatus | AttemptStatus): string {
  return `${from}->${to}`;
}

describe("job state transitions", () => {
  it("matches the complete allowed and forbidden transition matrix", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        expect(canTransitionJobStatus(from, to), transitionKey(from, to)).toBe(
          ALLOWED_JOB_TRANSITIONS.has(transitionKey(from, to)),
        );
      }
    }
  });

  it.each([
    ["COMPLETED", true],
    ["CANCELLED", true],
    ["EXPIRED", true],
    ["SOURCE_MUTATED", true],
    ["FAILED", false],
    ["RUNNING", false],
  ] satisfies readonly (readonly [JobStatus, boolean])[])(
    "classifies %s terminal=%s",
    (status, expected) => {
      expect(isTerminalJobStatus(status)).toBe(expected);
    },
  );

  it("allows retries only from FAILED", () => {
    for (const status of JOB_STATUSES) {
      expect(canRetryJob(status)).toBe(status === "FAILED");
    }
  });
});

describe("attempt state transitions", () => {
  it("matches the complete allowed and forbidden transition matrix", () => {
    for (const from of ATTEMPT_STATUSES) {
      for (const to of ATTEMPT_STATUSES) {
        expect(canTransitionAttemptStatus(from, to), transitionKey(from, to)).toBe(
          ALLOWED_ATTEMPT_TRANSITIONS.has(transitionKey(from, to)),
        );
      }
    }
  });

  it.each([
    ["COMPLETED", true],
    ["FAILED", true],
    ["CANCELLED", true],
    ["RUNNING", false],
  ] satisfies readonly (readonly [AttemptStatus, boolean])[])(
    "classifies %s terminal=%s",
    (status, expected) => {
      expect(isTerminalAttemptStatus(status)).toBe(expected);
    },
  );
});
