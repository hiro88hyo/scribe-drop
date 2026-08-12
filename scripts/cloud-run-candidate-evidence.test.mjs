import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createCloudRunCandidateEvidence,
  parseCloudRunCandidateEvidence,
  requireCloudRunCandidateEvidencePath,
  writeCloudRunCandidateEvidence,
} from "./cloud-run-candidate-evidence.mjs";

const controllerImage = `asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime@sha256:${"b".repeat(64)}`;
const workerImage = `asia-southeast1-docker.pkg.dev/scribe-drop/worker/runtime@sha256:${"a".repeat(64)}`;

function evidence() {
  return createCloudRunCandidateEvidence({
    commit: "c".repeat(40),
    controllerImage,
    runAttempt: "1",
    runId: "123",
    workerImage,
  });
}

test("creates metadata-only evidence for two immutable candidate images", () => {
  assert.deepEqual(evidence(), {
    commit: "c".repeat(40),
    controllerImage,
    runAttempt: "1",
    runId: "123",
    schemaVersion: 1,
    workerImage,
  });
});

test("rejects tags, cross-repository images, and unknown evidence fields", () => {
  assert.throws(() =>
    createCloudRunCandidateEvidence({
      ...evidence(),
      controllerImage: "asia-southeast1-docker.pkg.dev/scribe-drop/controller/runtime:latest",
    }),
  );
  assert.throws(() =>
    createCloudRunCandidateEvidence({
      ...evidence(),
      workerImage: controllerImage,
    }),
  );
  assert.throws(() => parseCloudRunCandidateEvidence({ ...evidence(), token: "forbidden" }));
  assert.throws(() => parseCloudRunCandidateEvidence({ ...evidence(), runId: 123 }));
});

test("writes evidence once with mode 0600 directly below RUNNER_TEMP", (testContext) => {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-cloud-run-candidate-"));
  testContext.after(() => rmSync(directory, { force: true, recursive: true }));
  const output = path.join(directory, "cloud-run-candidate.json");
  assert.equal(requireCloudRunCandidateEvidencePath(output, directory), output);
  assert.throws(() =>
    requireCloudRunCandidateEvidencePath(
      path.join(directory, "nested", "evidence.json"),
      directory,
    ),
  );

  writeCloudRunCandidateEvidence(output, evidence());
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(
    parseCloudRunCandidateEvidence(JSON.parse(readFileSync(output, "utf8"))),
    evidence(),
  );
  assert.throws(() => writeCloudRunCandidateEvidence(output, evidence()), /EEXIST/u);
});
