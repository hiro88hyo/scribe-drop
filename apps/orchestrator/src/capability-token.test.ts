import { describe, expect, it } from "vitest";

import {
  createCapabilityToken,
  hashCapabilityToken,
  timingSafeHashEqual,
} from "./capability-token.js";

describe("RunPod capability tokens", () => {
  it("encodes exactly 256 random bits as unpadded base64url and hashes the raw token", async () => {
    const capability = await createCapabilityToken((length) =>
      new Uint8Array(length).map((_, index) => index),
    );

    expect(capability.raw).toHaveLength(43);
    expect(capability.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(capability.hash).toBe(await hashCapabilityToken(capability.raw));
  });

  it("rejects a random source with the wrong length", async () => {
    await expect(createCapabilityToken(() => new Uint8Array(31))).rejects.toThrow(
      "invalid byte length",
    );
  });

  it("compares only valid SHA-256 hashes", async () => {
    const hash = await hashCapabilityToken("t".repeat(43));

    expect(timingSafeHashEqual(hash, hash)).toBe(true);
    expect(timingSafeHashEqual(hash, "b".repeat(64))).toBe(false);
    expect(timingSafeHashEqual(hash, "not-a-hash")).toBe(false);
  });
});
