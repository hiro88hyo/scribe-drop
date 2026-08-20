import { describe, expect, it } from "vitest";

import {
  matchesStagingAcceptanceFault,
  parseStagingAcceptanceFault,
  type StagingAcceptanceFaultEnvironment,
} from "./staging-acceptance-fault.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ISSUED_AT = "2026-08-14T01:00:00.000Z";
const EXPIRES_AT = "2026-08-14T01:30:00.000Z";

function environment(
  overrides: Partial<StagingAcceptanceFaultEnvironment> = {},
): StagingAcceptanceFaultEnvironment {
  return {
    APP_ENV: "staging",
    STAGING_ACCEPTANCE_FAULT: "notification_unavailable",
    STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: EXPIRES_AT,
    STAGING_ACCEPTANCE_FAULT_ISSUED_AT: ISSUED_AT,
    STAGING_ACCEPTANCE_FAULT_JOB_ID: JOB_ID,
    ...overrides,
  };
}

describe("staging acceptance fault lease", () => {
  it("is disabled only when every lease field is absent", () => {
    expect(parseStagingAcceptanceFault({ APP_ENV: "production" })).toBeUndefined();
    expect(parseStagingAcceptanceFault({ APP_ENV: "staging" })).toBeUndefined();
  });

  it("accepts an exact, bounded staging-only lease", () => {
    expect(parseStagingAcceptanceFault(environment())).toEqual({
      appEnvironment: "staging",
      expiresAt: EXPIRES_AT,
      fault: "notification_unavailable",
      issuedAt: ISSUED_AT,
      jobId: JOB_ID,
    });
  });

  const invalidOverrides: readonly Partial<StagingAcceptanceFaultEnvironment>[] = [
    { APP_ENV: "production" },
    { STAGING_ACCEPTANCE_FAULT: "arbitrary_network_error" },
    { STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: "2026-08-14T01:30:00+00:00" },
    { STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: "2026-08-14T01:30:00.001Z" },
    { STAGING_ACCEPTANCE_FAULT_JOB_ID: "not-a-job-id" },
  ];

  it.each(invalidOverrides)("rejects unsafe lease configuration: %o", (override) => {
    expect(() => parseStagingAcceptanceFault(environment(override))).toThrow(
      "Staging acceptance fault configuration is invalid",
    );
  });

  it("rejects a partially configured lease", () => {
    expect(() =>
      parseStagingAcceptanceFault({
        APP_ENV: "staging",
        STAGING_ACCEPTANCE_FAULT: "notification_unavailable",
        STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: EXPIRES_AT,
        STAGING_ACCEPTANCE_FAULT_JOB_ID: JOB_ID,
      }),
    ).toThrow("Staging acceptance fault configuration is invalid");
  });

  it("matches only the fault, job, and active time window", () => {
    const config = parseStagingAcceptanceFault(environment());
    expect(
      matchesStagingAcceptanceFault(
        config,
        "notification_unavailable",
        JOB_ID,
        new Date("2026-08-14T01:15:00.000Z"),
      ),
    ).toBe(true);
    expect(
      matchesStagingAcceptanceFault(
        config,
        "notification_unavailable",
        "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        new Date("2026-08-14T01:15:00.000Z"),
      ),
    ).toBe(false);
    expect(
      matchesStagingAcceptanceFault(
        config,
        "runtime_heartbeat_response_loss",
        JOB_ID,
        new Date("2026-08-14T01:15:00.000Z"),
      ),
    ).toBe(false);
    expect(
      matchesStagingAcceptanceFault(
        config,
        "notification_unavailable",
        JOB_ID,
        new Date(EXPIRES_AT),
      ),
    ).toBe(false);
  });
});
