import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkerSecretNames,
  verifyRequiredOrchestratorSecrets,
} from "./cloudflare-worker-secret-verifier.mjs";

const completeOutput = JSON.stringify([
  { name: "CLOUD_RUN_CONTROLLER_HMAC_PRIMARY", type: "secret_text" },
  { name: "CLOUD_RUN_RUNTIME_DERIVATION_SECRET", type: "secret_text" },
  { name: "RUNPOD_ENDPOINT_ID", type: "secret_text" },
  { name: "RUNPOD_API_KEY", type: "secret_text" },
  { name: "R2_ACCESS_KEY_ID", type: "secret_text" },
  { name: "R2_SECRET_ACCESS_KEY", type: "secret_text" },
  { name: "DISCORD_WEBHOOK_URL", type: "secret_text" },
]);

test("accepts environment-specific Orchestrator secret names without values", () => {
  assert.deepEqual(
    verifyRequiredOrchestratorSecrets(completeOutput, "staging", "synthetic-shadow"),
    {
      listedCount: 7,
      requiredCount: 7,
    },
  );
  assert.deepEqual(verifyRequiredOrchestratorSecrets(completeOutput, "staging", "disabled"), {
    listedCount: 7,
    requiredCount: 5,
  });
  assert.deepEqual(verifyRequiredOrchestratorSecrets(completeOutput, "production"), {
    listedCount: 7,
    requiredCount: 5,
  });
});

test("rejects missing, malformed, and value-bearing Worker secret output", () => {
  assert.throws(
    () =>
      verifyRequiredOrchestratorSecrets(
        JSON.stringify(JSON.parse(completeOutput).slice(2)),
        "staging",
        "synthetic-shadow",
      ),
    /CLOUD_RUN_CONTROLLER_HMAC_PRIMARY/u,
  );
  assert.throws(() => parseWorkerSecretNames("{}"), /must be an array/u);
  assert.throws(
    () => parseWorkerSecretNames('[{"name":"RUNPOD_API_KEY","value":"not-allowed"}]'),
    /invalid entry/u,
  );
  assert.throws(
    () => verifyRequiredOrchestratorSecrets(completeOutput, "staging", "invalid"),
    /mode is invalid/u,
  );
});
