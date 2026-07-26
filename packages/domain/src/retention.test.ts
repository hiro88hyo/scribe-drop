import { describe, expect, it } from "vitest";

import {
  R2_CAPABILITY_TTL_SECONDS,
  USER_DELETION_CAPABILITY_GRACE_SECONDS,
  deletionNotBeforeMilliseconds,
} from "./retention.js";

describe("user deletion safety window", () => {
  it("deletes immediately when no R2 capability was issued", () => {
    expect(deletionNotBeforeMilliseconds(10_000, null)).toBe(10_000);
  });

  it("waits for the R2 capability and deletion grace to expire", () => {
    expect(deletionNotBeforeMilliseconds(10_000, 5_000)).toBe(
      5_000 + (R2_CAPABILITY_TTL_SECONDS + USER_DELETION_CAPABILITY_GRACE_SECONDS) * 1_000,
    );
  });

  it("never schedules cleanup before the deletion request", () => {
    expect(deletionNotBeforeMilliseconds(10_000_000, 1_000)).toBe(10_000_000);
  });

  it("rejects unsafe timestamps", () => {
    expect(() => deletionNotBeforeMilliseconds(-1, null)).toThrow();
    expect(() => deletionNotBeforeMilliseconds(1, Number.NaN)).toThrow();
  });
});
