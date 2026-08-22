import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { exportEnvironmentPolicy } from "./export-environment-policy.mjs";
import { createRunpodStagingPlan } from "./runpod-environment-config.mjs";

const webOrigin = "https://web-staging.example.invalid";

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function fixture(directory) {
  const candidatePath = path.join(directory, "cloud-run-candidate.json");
  writeJson(candidatePath, {
    commit: "a".repeat(40),
    controllerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:${"c".repeat(64)}`,
    runAttempt: "1",
    runId: "123",
    schemaVersion: 1,
    workerImage: `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"d".repeat(64)}`,
  });
  writeJson(path.join(directory, ".wrangler/deploy/r2-cors-staging.json"), {
    rules: [
      {
        allowed: {
          headers: [
            "authorization",
            "content-type",
            "x-amz-content-sha256",
            "x-amz-date",
            "x-amz-security-token",
            "x-amz-user-agent",
            "amz-sdk-invocation-id",
            "amz-sdk-request",
          ],
          methods: ["GET", "POST", "PUT", "DELETE"],
          origins: [webOrigin],
        },
        exposeHeaders: ["etag"],
        id: "scribe-drop-browser-multipart-staging",
        maxAgeSeconds: 3600,
      },
    ],
  });
  writeJson(path.join(directory, ".wrangler/deploy/r2-lifecycle-staging.json"), {
    rules: [
      {
        abortMultipartUploadsTransition: { condition: { maxAge: 86400, type: "Age" } },
        conditions: { prefix: "incoming/" },
        deleteObjectsTransition: { condition: { maxAge: 604800, type: "Age" } },
        enabled: true,
        id: "scribe-drop-incoming-retention-staging",
      },
      {
        conditions: { prefix: "results/" },
        deleteObjectsTransition: { condition: { maxAge: 7776000, type: "Age" } },
        enabled: true,
        id: "scribe-drop-results-retention-staging",
      },
    ],
  });
  writeJson(
    path.join(directory, ".runpod/deploy/staging-plan.json"),
    createRunpodStagingPlan({
      accountId: "a".repeat(32),
      gpuTypeIds:
        "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition",
      image: `ghcr.io/example/scribe-drop-runpod-worker@sha256:${"b".repeat(64)}`,
      imageVisibility: "private",
      orchestratorOrigin: "https://orchestrator-staging.example.invalid",
      registryAuthId: "registry_staging",
    }),
  );
  return candidatePath;
}

function runExporter(directory, candidatePath, policy) {
  const githubEnvironmentPath = path.join(directory, `github-env-${policy}`);
  writeFileSync(githubEnvironmentPath, "", "utf8");
  const policyId = exportEnvironmentPolicy({
    environment: "staging",
    variables: {
      AUDIT_RETENTION_DAYS: "180",
      CLOUD_RUN_CANDIDATE_EVIDENCE_PATH: candidatePath,
      GITHUB_ENV: githubEnvironmentPath,
      MULTIPART_RETENTION_HOURS: "24",
      RESULT_RETENTION_DAYS: "90",
      SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
      SCRIBE_DROP_STAGING_GPU_EXECUTION_ADMISSION: "active",
      SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY: policy,
      SCRIBE_DROP_STAGING_WEB_ORIGIN: webOrigin,
      SOURCE_RETENTION_DAYS: "7",
    },
    workingDirectory: directory,
  });
  return { githubEnvironmentPath, policyId };
}

test("executes the parity exporter and rejects the preflight RunPod regression", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-environment-policy-"));
  try {
    const candidatePath = fixture(directory);
    assert.throws(
      () => runExporter(directory, candidatePath, "runpod_serverless_v1"),
      /Cloud Run environment policy is not active/u,
    );

    const accepted = runExporter(directory, candidatePath, "cloud_run_jobs_l4_v1");
    assert.match(accepted.policyId, /^[a-f0-9]{64}$/u);
    const exported = readFileSync(accepted.githubEnvironmentPath, "utf8").trim().split("\n");
    assert.equal(exported.length, 2);
    assert.match(exported[0] ?? "", /^ENVIRONMENT_POLICY_ID=[a-f0-9]{64}$/u);
    assert.equal(
      exported[1],
      exported[0]?.replace("ENVIRONMENT_POLICY_ID", "EXPECTED_ENVIRONMENT_POLICY_ID"),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
