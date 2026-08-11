import { describe, expect, it } from "vitest";

import { JsonControllerLogSink } from "./process.js";

describe("controller process logging", () => {
  it("serializes only the fixed controller log record", () => {
    const output: string[] = [];
    const logger = new JsonControllerLogSink((line) => output.push(line));

    logger.emit({
      action: "create",
      durationMs: 12,
      errorCode: "BUDGET_EXHAUSTED",
      event: "controller_request",
      outcome: "rejected",
      policyId: "cloud_run_jobs_l4_v1",
    });

    expect(output).toEqual([
      '{"action":"create","durationMs":12,"errorCode":"BUDGET_EXHAUSTED","event":"controller_request","outcome":"rejected","policyId":"cloud_run_jobs_l4_v1"}\n',
    ]);
  });
});
