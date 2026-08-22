import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  handOffStagingFailureEvidence,
  parseStagingFailureEvidence,
  readStagingFailureEvidence,
  requireStagingFailureEvidencePath,
  writeStagingFailureEvidence,
} from "../staging-failure-evidence.js";
import { JOB_ID } from "./mock-backend.js";

test("round-trips mode-600 staging failure evidence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-failure-evidence-"));
  try {
    const evidencePath = path.join(directory, "failure.json");
    writeStagingFailureEvidence(evidencePath, JOB_ID);

    expect(readStagingFailureEvidence(evidencePath)).toEqual({
      schemaVersion: 1,
      jobId: JOB_ID,
    });
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(evidencePath, "utf8")).not.toContain("token");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("hands cleanup ownership to workflow recovery only after evidence is durable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scribe-drop-failure-handoff-"));
  try {
    const evidencePath = path.join(directory, "failure.json");
    expect(handOffStagingFailureEvidence(evidencePath, JOB_ID)).toBe(true);
    expect(readStagingFailureEvidence(evidencePath).jobId).toBe(JOB_ID);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects malformed evidence and non-absolute paths", () => {
  expect(() =>
    parseStagingFailureEvidence({
      schemaVersion: 1,
      jobId: JOB_ID,
      unexpected: true,
    }),
  ).toThrow("unexpected fields");
  expect(() =>
    parseStagingFailureEvidence({
      schemaVersion: 1,
      jobId: "not-a-job",
    }),
  ).toThrow();
  expect(() => requireStagingFailureEvidencePath("relative.json")).toThrow("absolute path");
});
