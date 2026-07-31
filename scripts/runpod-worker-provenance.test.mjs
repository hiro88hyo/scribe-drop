import assert from "node:assert/strict";
import { test } from "node:test";

import { createRunpodWorkerProvenance } from "./runpod-worker-provenance.mjs";

const candidateCommitSha = "a".repeat(40);
const candidateRunId = "123";
const digest = "b".repeat(64);
const image = `ghcr.io/example/scribe-drop-runpod-worker@sha256:${digest}`;

test("records a Worker built and rescanned in the current candidate run", () => {
  assert.deepEqual(
    createRunpodWorkerProvenance({
      candidateCommitSha,
      candidateRunId,
      image,
    }),
    {
      schemaVersion: 1,
      mode: "built",
      candidate: {
        commitSha: candidateCommitSha,
        runId: candidateRunId,
      },
      image: { digest },
      source: {
        commitSha: candidateCommitSha,
        candidateRunId,
      },
      currentRunVerification: {
        offlineContainerCheck: true,
        sbomGenerated: true,
        vulnerabilityScan: true,
      },
    },
  );
});

test("records the trusted source candidate for a reused and rescanned Worker", () => {
  const sourceCommitSha = "c".repeat(40);
  const sourceCandidateRunId = "456";
  const provenance = createRunpodWorkerProvenance({
    candidateCommitSha,
    candidateRunId,
    image,
    sourceCandidateRunId,
    sourceCommitSha,
  });

  assert.equal(provenance.mode, "reused");
  assert.deepEqual(provenance.source, {
    commitSha: sourceCommitSha,
    candidateRunId: sourceCandidateRunId,
  });
  assert.equal(provenance.image.digest, digest);
});

test("rejects partial source identity and mutable image references", () => {
  assert.throws(
    () =>
      createRunpodWorkerProvenance({
        candidateCommitSha,
        candidateRunId,
        image,
        sourceCommitSha: "c".repeat(40),
      }),
    /Worker source candidate run ID is invalid/u,
  );
  assert.throws(
    () =>
      createRunpodWorkerProvenance({
        candidateCommitSha,
        candidateRunId,
        image: "ghcr.io/example/scribe-drop-runpod-worker:latest",
      }),
    /RunPod Worker image is invalid/u,
  );
});
