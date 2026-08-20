import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  requiredProductionVariableNames,
  verifyProductionEnvironmentContract,
} from "./production-environment-contract.mjs";

const runpodWorkerImage = "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "b".repeat(64);
const cloudRunCandidate = {
  commit: "a".repeat(40),
  controllerImage:
    "asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:" + "c".repeat(64),
  runAttempt: "1",
  runId: "123",
  schemaVersion: 1,
  workerImage: "asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:" + "d".repeat(64),
};
const templates = {
  cors: readFileSync("infra/cloudflare/r2-cors.production.json", "utf8"),
  lifecycle: readFileSync("infra/cloudflare/r2-lifecycle.production.json", "utf8"),
  orchestrator: readFileSync("apps/orchestrator/wrangler.toml", "utf8"),
  web: readFileSync("apps/web/wrangler.production.toml", "utf8"),
};

function variables() {
  const values = {
    AUDIT_RETENTION_DAYS: "180",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    MULTIPART_RETENTION_HOURS: "24",
    RESULT_RETENTION_DAYS: "90",
    SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE: "production-access-audience",
    SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN:
      "https://scribe-drop-production.cloudflareaccess.com",
    SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION: "1",
    SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID: "abcdef12-1234-4abc-8def-1234567890ab",
    SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN: "https://orchestrator-production.example.invalid",
    SCRIBE_DROP_PRODUCTION_PAGES_PROJECT: "scribe-drop-web-production",
    SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS:
      "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition",
    SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE_VISIBILITY: "private",
    SCRIBE_DROP_PRODUCTION_RUNPOD_REGISTRY_AUTH_ID: "registry_production",
    SCRIBE_DROP_PRODUCTION_WEB_ORIGIN: "https://web-production.example.invalid",
    SOURCE_RETENTION_DAYS: "7",
  };
  return requiredProductionVariableNames.map((name) => ({ name, value: values[name] }));
}

function verify(records = variables(), expectedEnvironmentPolicyId) {
  return verifyProductionEnvironmentContract({
    cloudRunCandidate,
    expectedEnvironmentPolicyId,
    runpodWorkerImage,
    templates,
    variables: records,
  });
}

test("validates every production value and computes the accepted parity identity", () => {
  const first = verify();
  assert.equal(first.variableCount, requiredProductionVariableNames.length);
  assert.deepEqual(verify(variables(), first.policyId), first);
});

test("reproduces the rejected two-GPU production Environment drift", () => {
  const drifted = variables().map((entry) =>
    entry.name === "SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS"
      ? { ...entry, value: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090" }
      : entry,
  );
  assert.throws(() => verify(drifted), /SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS/u);
});

test("reports independent production value drift in one pass", () => {
  const drifted = variables().map((entry) => {
    if (entry.name === "SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS") {
      return { ...entry, value: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090" };
    }
    if (entry.name === "SCRIBE_DROP_PRODUCTION_PAGES_PROJECT") {
      return { ...entry, value: "other-production" };
    }
    return entry;
  });
  assert.throws(
    () => verify(drifted),
    (error) =>
      error instanceof Error &&
      /Pages project/u.test(error.message) &&
      /SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS/u.test(error.message),
  );
});

test("rejects missing, extra, malformed, and staging-divergent values", () => {
  assert.throws(() => verify(variables().slice(1)), /reviewed set/u);
  assert.throws(
    () => verify([...variables(), { name: "LEGACY_VALUE", value: "legacy" }]),
    /reviewed set/u,
  );
  const badPages = variables().map((entry) =>
    entry.name === "SCRIBE_DROP_PRODUCTION_PAGES_PROJECT"
      ? { ...entry, value: "other-production" }
      : entry,
  );
  assert.throws(() => verify(badPages), /Pages project/u);
  assert.throws(() => verify(variables(), "e".repeat(64)), /does not match staging acceptance/u);
});
