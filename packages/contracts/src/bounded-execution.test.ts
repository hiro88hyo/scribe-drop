import { describe, expect, it } from "vitest";

import fixture from "../fixtures/bounded-execution-v2.json";
import {
  boundedExecutionOptionsSchema,
  boundedResultCapabilitiesSchema,
  boundedResultManifestSchema,
} from "./bounded-execution.js";

describe("bounded execution v2 and result manifest v3 schemas", () => {
  it("accepts the shared exact-format fixture", () => {
    expect(boundedExecutionOptionsSchema.safeParse(fixture.options).success).toBe(true);
    expect(boundedResultCapabilitiesSchema.safeParse(fixture.capabilities).success).toBe(true);
    expect(boundedResultManifestSchema.safeParse(fixture.manifest).success).toBe(true);
  });

  it("accepts English and rejects unknown execution languages", () => {
    expect(
      boundedExecutionOptionsSchema.safeParse({ ...fixture.options, language: "en" }).success,
    ).toBe(true);
    expect(
      boundedExecutionOptionsSchema.safeParse({ ...fixture.options, language: "en-US" }).success,
    ).toBe(false);
  });

  it.each([
    ["empty", []],
    ["duplicate", ["json", "json"]],
    ["reordered", ["json", "markdown"]],
    ["unknown", ["markdown", "txt"]],
  ])("rejects %s execution output formats", (_name, outputFormats) => {
    expect(
      boundedExecutionOptionsSchema.safeParse({
        ...(fixture.options as object),
        outputFormats,
      }).success,
    ).toBe(false);
  });

  it("rejects language drift, extra, missing, reordered, and old manifest artifacts", () => {
    const manifest = fixture.manifest as {
      artifacts: unknown[];
      requestedFormats: string[];
      schemaVersion: number;
    };
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        artifacts: manifest.artifacts.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        detectedLanguage: "ja",
      }).success,
    ).toBe(false);
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        requestedLanguage: "en-US",
      }).success,
    ).toBe(false);
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        artifacts: [...manifest.artifacts].reverse(),
      }).success,
    ).toBe(false);
    const firstArtifact = manifest.artifacts[0] as { key: string };
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        artifacts: [
          { ...firstArtifact, key: firstArtifact.key.replace("transcript.md", "transcript.json") },
          manifest.artifacts[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      boundedResultManifestSchema.safeParse({
        ...manifest,
        artifacts: manifest.artifacts.map((artifact) => {
          const value = artifact as { key: string };
          return {
            ...value,
            key: value.key.replace("01ARZ3NDEKTSV4RRFFQ69G5FAW", "01ARZ3NDEKTSV4RRFFQ69G5FAX"),
          };
        }),
      }).success,
    ).toBe(false);
    expect(boundedResultManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(boundedResultManifestSchema.safeParse({ ...manifest, token: "forbidden" }).success).toBe(
      false,
    );
  });
});
