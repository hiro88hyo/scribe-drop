import { describe, expect, it } from "vitest";

import { parseRetentionConfig, type RetentionConfigEnvironment } from "./config.js";

function retentionEnvironment(
  overrides: Partial<RetentionConfigEnvironment> = {},
): RetentionConfigEnvironment {
  return {
    AUDIT_RETENTION_DAYS: "180",
    MULTIPART_RETENTION_HOURS: "24",
    RESULT_RETENTION_DAYS: "90",
    SOURCE_RETENTION_DAYS: "7",
    ...overrides,
  };
}

describe("retention configuration", () => {
  it("parses the documented defaults as bounded integers", () => {
    expect(parseRetentionConfig(retentionEnvironment())).toEqual({
      auditRetentionDays: 180,
      multipartRetentionHours: 24,
      resultRetentionDays: 90,
      sourceRetentionDays: 7,
    });
  });

  it.each([
    { SOURCE_RETENTION_DAYS: "0" },
    { RESULT_RETENTION_DAYS: "90.5" },
    { AUDIT_RETENTION_DAYS: "unbounded" },
    { MULTIPART_RETENTION_HOURS: "721" },
    { SOURCE_RETENTION_DAYS: "91" },
    { RESULT_RETENTION_DAYS: "181" },
  ])("fails closed for invalid or contradictory retention values: %o", (override) => {
    expect(parseRetentionConfig(retentionEnvironment(override))).toBeUndefined();
  });
});
