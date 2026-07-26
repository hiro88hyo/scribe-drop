import { describe, expect, it } from "vitest";

import { DeterministicFaultPlan, InjectedFaultError, inspectStructuredLogs } from "./index.js";

describe("deterministic fault plan", () => {
  it("injects only the configured occurrence and proves the schedule was exercised", async () => {
    const plan = new DeterministicFaultPlan([
      {
        occurrences: [2],
        point: "r2.get",
      },
    ]);

    await expect(plan.before("r2.get", () => Promise.resolve("first"))).resolves.toBe("first");
    await expect(plan.before("r2.get", () => Promise.resolve("second"))).rejects.toMatchObject({
      occurrence: 2,
      point: "r2.get",
    });
    expect(plan.count("r2.get")).toBe(2);
    expect(() => {
      plan.assertExhausted();
    }).not.toThrow();
  });

  it("can lose a response after an external effect has completed", async () => {
    const effects: string[] = [];
    const plan = new DeterministicFaultPlan([
      {
        occurrences: [1],
        point: "runpod.response",
      },
    ]);

    await expect(
      plan.after("runpod.response", () => {
        effects.push("accepted");
        return Promise.resolve("provider-job");
      }),
    ).rejects.toBeInstanceOf(InjectedFaultError);
    expect(effects).toEqual(["accepted"]);
    expect(() => {
      plan.assertExhausted();
    }).not.toThrow();
  });

  it("rejects an unexercised fault schedule", () => {
    const plan = new DeterministicFaultPlan([
      {
        occurrences: [1],
        point: "d1.cas",
      },
    ]);
    expect(() => {
      plan.assertExhausted();
    }).toThrow("was not exercised");
  });
});

describe("structured log inspection", () => {
  it("validates the envelope and rejects secret or body fixture fragments", () => {
    const safeRecord = JSON.stringify({
      environment: "local",
      event: "job.deferred",
      level: "warn",
      service: "orchestrator",
      timestamp: "2026-07-26T00:00:00.000Z",
    });
    expect(inspectStructuredLogs([safeRecord], ["signed-query", "fixture transcript"])).toEqual({
      events: ["job.deferred"],
      recordCount: 1,
    });
    expect(() => inspectStructuredLogs([`${safeRecord}signed-query`], ["signed-query"])).toThrow(
      "forbidden fragment",
    );
  });
});
