import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionSmokeD1Arguments,
  parseProductionSmokeObservation,
  productionSmokeQuery,
} from "./production-smoke.mjs";

const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const attemptId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const prefix = `results/${"a".repeat(32)}/${jobId}/${attemptId}/`;

function row(format) {
  return {
    attempt_id: attemptId,
    attempt_status: "COMPLETED",
    cleanup_status: "SUCCEEDED",
    execution_status: "TERMINAL",
    format,
    job_id: jobId,
    job_notified: 1,
    job_status: "COMPLETED",
    object_key: `${prefix}transcript.${format === "markdown" ? "md" : format}`,
    outbox_sent: 1,
    outbox_status: "SENT",
    provider_kind: "cloud_run_jobs",
    provider_policy: "cloud_run_jobs_l4_v1",
    runpod_execution_ms: 258_000,
    result_prefix: prefix,
    sha256: "b".repeat(64),
    size_bytes: 12,
    source_key: `incoming/${"a".repeat(32)}/${jobId}/${"n".repeat(22)}/source.m4a`,
    successful_terminal_count: 1,
    terminal_status: "COMPLETED",
  };
}

test("accepts only one complete Cloud Run smoke graph with three artifacts", () => {
  const observation = parseProductionSmokeObservation(
    [{ results: [row("json"), row("markdown"), row("srt")], success: true }],
    jobId,
  );
  assert.equal(observation.attemptId, attemptId);
  assert.equal(observation.artifactKeys.length, 3);
  assert.equal(observation.manifestKey, `${prefix}manifest.json`);
  assert.equal(observation.processingMilliseconds, 258_000);
});

test("rejects a missing notification, artifact, or provider cleanup", () => {
  const base = [row("json"), row("markdown"), row("srt")];
  for (const changed of [
    base.slice(0, 2),
    base.map((entry) => ({ ...entry, outbox_status: "PENDING" })),
    base.map((entry) => ({ ...entry, cleanup_status: "PENDING" })),
    base.map((entry) => ({ ...entry, runpod_execution_ms: null })),
  ]) {
    assert.throws(
      () => parseProductionSmokeObservation([{ results: changed, success: true }], jobId),
      /Production smoke/u,
    );
  }
});

test("builds a fixed read-only production D1 command", () => {
  const query = productionSmokeQuery(jobId);
  assert.match(query, /WHERE jobs\.id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'/u);
  assert.doesNotMatch(query, /owner_email|title|original_filename/u);
  assert.deepEqual(
    createProductionSmokeD1Arguments(jobId, "/tmp/orchestrator-production.toml").slice(0, 5),
    ["exec", "wrangler", "d1", "execute", "SCRIBE_DROP_DB"],
  );
});
