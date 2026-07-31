import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { readCandidateFixture } from "../candidate-fixture.js";

test("reads a repository-relative candidate independently of the package working directory", () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "scribe-drop-candidate-fixture-"));
  const fixtureDirectory = path.join(repositoryRoot, "release-candidate", "acceptance-fixtures");

  try {
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(
      path.join(fixtureDirectory, "metadata.json"),
      JSON.stringify({
        filename: "android-aac.m4a",
        mediaType: "audio/mp4a-latm",
        schemaVersion: 1,
        synthetic: true,
      }),
    );
    writeFileSync(path.join(fixtureDirectory, "android-aac.m4a"), "synthetic-media");

    expect(readCandidateFixture("release-candidate", repositoryRoot).toString("utf8")).toBe(
      "synthetic-media",
    );
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test("rejects candidate fixture metadata that changes the accepted media contract", () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "scribe-drop-candidate-fixture-"));
  const fixtureDirectory = path.join(repositoryRoot, "release-candidate", "acceptance-fixtures");

  try {
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(
      path.join(fixtureDirectory, "metadata.json"),
      JSON.stringify({
        filename: "android-aac.m4a",
        mediaType: "audio/mp4",
        schemaVersion: 1,
        synthetic: true,
      }),
    );
    writeFileSync(path.join(fixtureDirectory, "android-aac.m4a"), "synthetic-media");

    expect(() => readCandidateFixture("release-candidate", repositoryRoot)).toThrow(
      "Release candidate acceptance fixture metadata is invalid",
    );
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});
