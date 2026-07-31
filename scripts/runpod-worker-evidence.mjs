import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateRunpodWorkerEvidence } from "./runpod-active-worker.mjs";

export const STAGING_RUNPOD_WORKER_EVIDENCE_FILENAME = "staging-runpod-worker-evidence.json";

export function requireStagingRunpodWorkerEvidencePath({ configuredPath, runnerTemp }) {
  if (typeof runnerTemp !== "string" || typeof configuredPath !== "string") {
    throw new Error("RunPod staging worker evidence path is missing");
  }
  const expectedPath = path.resolve(runnerTemp, STAGING_RUNPOD_WORKER_EVIDENCE_FILENAME);
  if (path.resolve(configuredPath) !== expectedPath) {
    throw new Error("RunPod staging worker evidence path is invalid");
  }
  return expectedPath;
}

export function assertStagingRunpodWorkerEvidenceAbsent(evidencePath) {
  if (existsSync(evidencePath)) {
    throw new Error("RunPod staging worker evidence already exists");
  }
}

export function readStagingRunpodWorkerEvidence(evidencePath) {
  try {
    return validateRunpodWorkerEvidence(JSON.parse(readFileSync(evidencePath, "utf8")));
  } catch {
    throw new Error("RunPod staging worker evidence is missing or invalid");
  }
}

export function writeStagingRunpodWorkerEvidence(evidencePath, untrustedEvidence) {
  const evidence = validateRunpodWorkerEvidence(untrustedEvidence);
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function deleteStagingRunpodWorkerEvidence(evidencePath) {
  try {
    unlinkSync(evidencePath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw new Error("RunPod staging worker evidence cleanup failed", { cause: error });
    }
  }
}
