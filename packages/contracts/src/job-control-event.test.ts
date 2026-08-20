import { describe, expect, it } from "vitest";

import { jobControlEventSchema } from "./job-control-event.js";

const event = {
  action: "cancel",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  requestedAt: "2026-08-14T14:06:14.974Z",
  schemaVersion: 1,
  type: "job-control",
} as const;

describe("jobControlEventSchema", () => {
  it("accepts the strict bounded cancellation event", () => {
    expect(jobControlEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ["unknown action", { ...event, action: "delete" }],
    ["unknown field", { ...event, ownerSub: "private-owner" }],
    ["invalid job ID", { ...event, jobId: "not-a-job" }],
    ["non-UTC timestamp", { ...event, requestedAt: "2026-08-14T23:06:14.974+09:00" }],
    ["future schema", { ...event, schemaVersion: 2 }],
  ])("rejects %s", (_caseName, input) => {
    expect(jobControlEventSchema.safeParse(input).success).toBe(false);
  });
});
