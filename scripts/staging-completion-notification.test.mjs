import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStagingCompletionD1Arguments,
  parseStagingCompletionObservation,
  waitForStagingCompletionNotification,
} from "./staging-completion-notification.mjs";

const jobId = "01J00000000000000000000000";

function wranglerResult(overrides = {}) {
  return [
    {
      success: true,
      results: [
        {
          attempt_status: "COMPLETED",
          duration_seconds: 60,
          job_notified: 1,
          job_status: "COMPLETED",
          job_version: 3,
          outbox_job_version: 3,
          outbox_sent: 1,
          outbox_status: "SENT",
          provider_kind: "cloud_run_jobs",
          provider_policy: "cloud_run_jobs_l4_v1",
          runpod_execution_ms: 258_000,
          ...overrides,
        },
      ],
    },
  ];
}

test("accepts a sent Cloud Run completion with a positive processing time", async () => {
  const observation = parseStagingCompletionObservation(wranglerResult());
  assert.equal(observation?.processingMilliseconds, 258_000);
  await assert.doesNotReject(
    waitForStagingCompletionNotification(() => Promise.resolve(observation), { attempts: 1 }),
  );
});

test("rejects missing processing time and non-Cloud Run completion", async () => {
  assert.throws(
    () => parseStagingCompletionObservation(wranglerResult({ runpod_execution_ms: null })),
    /processing time/u,
  );
  const observation = parseStagingCompletionObservation(
    wranglerResult({ provider_kind: "runpod", provider_policy: "runpod_serverless_v1" }),
  );
  await assert.rejects(
    waitForStagingCompletionNotification(() => Promise.resolve(observation), { attempts: 1 }),
    /Cloud Run lifecycle/u,
  );
});

test("waits for the current notification generation and rejects dead delivery", async () => {
  const observations = [
    parseStagingCompletionObservation(
      wranglerResult({ job_notified: 0, outbox_sent: 0, outbox_status: "PENDING" }),
    ),
    parseStagingCompletionObservation(wranglerResult()),
  ];
  const result = await waitForStagingCompletionNotification(
    () => Promise.resolve(observations.shift()),
    { attempts: 2, intervalMilliseconds: 1, sleep: () => Promise.resolve() },
  );
  assert.equal(result.outboxStatus, "SENT");
  await assert.rejects(
    waitForStagingCompletionNotification(
      () =>
        Promise.resolve(
          parseStagingCompletionObservation(wranglerResult({ outbox_status: "DEAD" })),
        ),
      { attempts: 1 },
    ),
    /notification is dead/u,
  );
});

test("builds a fixed read-only staging D1 command", () => {
  const arguments_ = createStagingCompletionD1Arguments({
    configPath: "/workspace/.wrangler/deploy/orchestrator-staging.toml",
    jobId,
  });
  assert.deepEqual(arguments_.slice(0, 5), ["exec", "wrangler", "d1", "execute", "SCRIBE_DROP_DB"]);
  assert.equal(arguments_.includes("--command"), true);
  assert.equal(arguments_.includes("--file"), false);
  assert.match(arguments_[arguments_.indexOf("--command") + 1], /runpod_execution_ms/u);
});
