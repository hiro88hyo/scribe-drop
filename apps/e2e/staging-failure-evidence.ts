import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ulidSchema } from "@scribe-drop/contracts";

const schemaVersion = 1;

export interface StagingFailureEvidence {
  readonly schemaVersion: 1;
  readonly jobId: string;
}

function requireExactObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Staging failure evidence is invalid");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "jobId" || keys[1] !== "schemaVersion") {
    throw new Error("Staging failure evidence contains unexpected fields");
  }
  return value as Record<string, unknown>;
}

export function requireStagingFailureEvidencePath(value: string | undefined): string {
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error("STAGING_FAILURE_EVIDENCE_PATH must be an absolute path");
  }
  return path.normalize(value);
}

export function parseStagingFailureEvidence(value: unknown): StagingFailureEvidence {
  const record = requireExactObject(value);
  if (record["schemaVersion"] !== schemaVersion) {
    throw new Error("Staging failure evidence schema version is invalid");
  }
  return {
    schemaVersion,
    jobId: ulidSchema.parse(record["jobId"]),
  };
}

export function readStagingFailureEvidence(evidencePath: string): StagingFailureEvidence {
  return parseStagingFailureEvidence(JSON.parse(readFileSync(evidencePath, "utf8")) as unknown);
}

export function writeStagingFailureEvidence(
  evidencePath: string,
  jobId: string,
): StagingFailureEvidence {
  const evidence = parseStagingFailureEvidence({
    schemaVersion,
    jobId,
  });
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return evidence;
}
