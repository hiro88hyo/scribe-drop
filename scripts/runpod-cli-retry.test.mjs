import assert from "node:assert/strict";
import { test } from "node:test";

import { runRunpodCliWithReadRetry } from "./runpod-cli-retry.mjs";

test("retries malformed read responses with bounded exponential backoff", () => {
  const sleeps = [];
  const retries = [];
  let attempts = 0;
  const result = runRunpodCliWithReadRetry(
    ["template", "get", "template"],
    () => {
      attempts += 1;
      return attempts < 3 ? { error: {} } : { id: "template" };
    },
    {
      jitter: () => 0,
      onRetry: (retry) => retries.push(retry),
      sleep: (milliseconds) => sleeps.push(milliseconds),
    },
  );

  assert.deepEqual(result, { id: "template" });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.deepEqual(
    retries.map(({ attempt, command, maximumAttempts }) => ({
      attempt,
      command,
      maximumAttempts,
    })),
    [
      { attempt: 2, command: "template get", maximumAttempts: 3 },
      { attempt: 3, command: "template get", maximumAttempts: 3 },
    ],
  );
});

test("retries thrown read failures but fails after the fixed upper bound", () => {
  let attempts = 0;
  assert.throws(
    () =>
      runRunpodCliWithReadRetry(
        ["serverless", "get", "endpoint"],
        () => {
          attempts += 1;
          throw new Error("safe test failure");
        },
        {
          jitter: () => 0,
          sleep: () => {},
        },
      ),
    /safe test failure/u,
  );
  assert.equal(attempts, 3);
});

test("never retries mutating commands with an unknown outcome", () => {
  let attempts = 0;
  let sleeps = 0;
  assert.throws(
    () =>
      runRunpodCliWithReadRetry(
        ["serverless", "update", "endpoint", "--template-id", "template"],
        () => {
          attempts += 1;
          throw new Error("update outcome unknown");
        },
        {
          jitter: () => 0,
          sleep: () => {
            sleeps += 1;
          },
        },
      ),
    /outcome unknown/u,
  );
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test("does not hide a structurally valid response from strict plan validation", () => {
  const mismatchedTemplate = { id: "template", ports: ["22/tcp"] };
  assert.equal(
    runRunpodCliWithReadRetry(["template", "get", "template"], () => mismatchedTemplate),
    mismatchedTemplate,
  );
});
