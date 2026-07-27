import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkerSecretNames,
  verifyRequiredOrchestratorSecrets,
} from "./cloudflare-worker-secret-verifier.mjs";

const completeOutput = JSON.stringify([
  { name: "RUNPOD_ENDPOINT_ID", type: "secret_text" },
  { name: "RUNPOD_API_KEY", type: "secret_text" },
  { name: "R2_ACCESS_KEY_ID", type: "secret_text" },
  { name: "R2_SECRET_ACCESS_KEY", type: "secret_text" },
  { name: "DISCORD_WEBHOOK_URL", type: "secret_text" },
]);

test("accepts all required Orchestrator secret names without values", () => {
  assert.deepEqual(verifyRequiredOrchestratorSecrets(completeOutput), {
    listedCount: 5,
    requiredCount: 5,
  });
});

test("rejects missing, malformed, and value-bearing Worker secret output", () => {
  assert.throws(
    () => verifyRequiredOrchestratorSecrets(JSON.stringify(JSON.parse(completeOutput).slice(0, 4))),
    /DISCORD_WEBHOOK_URL/u,
  );
  assert.throws(() => parseWorkerSecretNames("{}"), /must be an array/u);
  assert.throws(
    () => parseWorkerSecretNames('[{"name":"RUNPOD_API_KEY","value":"not-allowed"}]'),
    /invalid entry/u,
  );
});
