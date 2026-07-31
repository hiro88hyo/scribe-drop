import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertStagingRunpodWorkerEvidenceAbsent,
  deleteStagingRunpodWorkerEvidence,
  readStagingRunpodWorkerEvidence,
  requireStagingRunpodWorkerEvidencePath,
  STAGING_RUNPOD_WORKER_EVIDENCE_FILENAME,
  writeStagingRunpodWorkerEvidence,
} from "./runpod-worker-evidence.mjs";

const evidence = {
  id: "worker_candidate",
  lastStartedAtMs: Date.parse("2026-07-31T11:45:25.960Z"),
};

function createFixture(testContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-worker-evidence-"));
  testContext.after(() => {
    rmSync(directory, { force: true, recursive: true });
  });
  return {
    directory,
    evidencePath: path.join(directory, STAGING_RUNPOD_WORKER_EVIDENCE_FILENAME),
  };
}

test("accepts only the fixed evidence file directly below runner temp", (testContext) => {
  const fixture = createFixture(testContext);
  assert.equal(
    requireStagingRunpodWorkerEvidencePath({
      configuredPath: fixture.evidencePath,
      runnerTemp: fixture.directory,
    }),
    fixture.evidencePath,
  );
  assert.throws(
    () =>
      requireStagingRunpodWorkerEvidencePath({
        configuredPath: path.join(
          fixture.directory,
          "nested",
          STAGING_RUNPOD_WORKER_EVIDENCE_FILENAME,
        ),
        runnerTemp: fixture.directory,
      }),
    /evidence path is invalid/u,
  );
  assert.throws(() => requireStagingRunpodWorkerEvidencePath({}), /evidence path is missing/u);
});

test("persists validated evidence once with mode 0600", (testContext) => {
  const fixture = createFixture(testContext);
  assertStagingRunpodWorkerEvidenceAbsent(fixture.evidencePath);
  writeStagingRunpodWorkerEvidence(fixture.evidencePath, evidence);

  assert.equal(statSync(fixture.evidencePath).mode & 0o777, 0o600);
  assert.deepEqual(readStagingRunpodWorkerEvidence(fixture.evidencePath), evidence);
  assert.equal(readFileSync(fixture.evidencePath, "utf8"), `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => assertStagingRunpodWorkerEvidenceAbsent(fixture.evidencePath),
    /evidence already exists/u,
  );
  assert.throws(() => writeStagingRunpodWorkerEvidence(fixture.evidencePath, evidence), /EEXIST/u);
});

test("rejects malformed evidence read from the runner file", (testContext) => {
  const fixture = createFixture(testContext);
  writeFileSync(fixture.evidencePath, '{"unexpected":true}\n', { mode: 0o600 });
  assert.throws(
    () => readStagingRunpodWorkerEvidence(fixture.evidencePath),
    /evidence is missing or invalid/u,
  );
});

test("deletes evidence idempotently", (testContext) => {
  const fixture = createFixture(testContext);
  writeStagingRunpodWorkerEvidence(fixture.evidencePath, evidence);
  deleteStagingRunpodWorkerEvidence(fixture.evidencePath);
  assertStagingRunpodWorkerEvidenceAbsent(fixture.evidencePath);
  assert.doesNotThrow(() => deleteStagingRunpodWorkerEvidence(fixture.evidencePath));
});
