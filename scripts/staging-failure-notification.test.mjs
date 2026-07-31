import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseStagingFailureEvidence,
  parseWranglerD1Observation,
  waitForStagingFailureNotification,
} from "./staging-failure-notification.mjs";

const jobId = "01J00000000000000000000000";

function wranglerResult(overrides = {}) {
  return [
    {
      success: true,
      results: [
        {
          job_status: "FAILED",
          job_version: 3,
          job_notified: 1,
          outbox_status: "SENT",
          outbox_job_version: 3,
          outbox_sent: 1,
          ...overrides,
        },
      ],
    },
  ];
}

test("accepts strict synthetic failure evidence", () => {
  assert.deepEqual(parseStagingFailureEvidence({ schemaVersion: 1, jobId }), {
    schemaVersion: 1,
    jobId,
  });
  assert.throws(
    () => parseStagingFailureEvidence({ schemaVersion: 1, jobId, token: "forbidden" }),
    /unexpected or missing fields/u,
  );
  assert.throws(
    () => parseStagingFailureEvidence({ schemaVersion: 1, jobId: "invalid" }),
    /invalid/u,
  );
});

test("parses only the allowlisted D1 observation", () => {
  assert.deepEqual(parseWranglerD1Observation(wranglerResult()), {
    jobStatus: "FAILED",
    jobVersion: 3,
    jobNotified: true,
    outboxJobVersion: 3,
    outboxSent: true,
    outboxStatus: "SENT",
  });
  assert.throws(
    () => parseWranglerD1Observation(wranglerResult({ transcript: "forbidden" })),
    /unexpected or missing fields/u,
  );
});

test("waits for the current generation to be sent", async () => {
  const observations = [
    parseWranglerD1Observation(
      wranglerResult({
        job_notified: 0,
        outbox_status: "PENDING",
        outbox_sent: 0,
      }),
    ),
    parseWranglerD1Observation(wranglerResult()),
  ];
  let sleeps = 0;
  const result = await waitForStagingFailureNotification(
    () => Promise.resolve(observations.shift()),
    {
      attempts: 2,
      intervalMilliseconds: 1,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    },
  );
  assert.equal(result.outboxStatus, "SENT");
  assert.equal(sleeps, 1);
});

test("rejects dead, stale, and missing failure notifications", async () => {
  await assert.rejects(
    waitForStagingFailureNotification(
      () =>
        Promise.resolve(
          parseWranglerD1Observation(
            wranglerResult({
              job_notified: 0,
              outbox_status: "DEAD",
              outbox_sent: 0,
            }),
          ),
        ),
      { attempts: 1 },
    ),
    /notification is dead/u,
  );
  await assert.rejects(
    waitForStagingFailureNotification(
      () =>
        Promise.resolve(
          parseWranglerD1Observation(
            wranglerResult({
              outbox_job_version: 2,
            }),
          ),
        ),
      { attempts: 1 },
    ),
    /not delivered in time/u,
  );
  await assert.rejects(
    waitForStagingFailureNotification(() => Promise.resolve(undefined), {
      attempts: 1,
    }),
    /job is missing/u,
  );
});
