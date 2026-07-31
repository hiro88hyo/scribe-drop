import { describe, expect, it } from "vitest";

import { createOwnerHash, createSourceKey } from "../src/server/jobs/job-source-key.js";

const JOB_ID = "01JGFJJZ00G40R40M30E209185";
const OWNER_SECRET = "test-owner-hash-secret-at-least-32-bytes";

describe("job source key", () => {
  it("derives a stable non-reversible owner hash and a random final key", async () => {
    const ownerHash = await createOwnerHash("identity-provider-subject", OWNER_SECRET);
    const sameOwnerHash = await createOwnerHash("identity-provider-subject", OWNER_SECRET);
    const otherOwnerHash = await createOwnerHash("other-subject", OWNER_SECRET);

    expect(ownerHash).toMatch(/^[0-9a-f]{32}$/u);
    expect(sameOwnerHash).toBe(ownerHash);
    expect(otherOwnerHash).not.toBe(ownerHash);

    const key = await createSourceKey(
      "identity-provider-subject",
      OWNER_SECRET,
      JOB_ID,
      "audio/mp4",
      (length) => new Uint8Array(length).fill(7),
    );
    expect(key).toMatch(
      new RegExp(`^incoming/${ownerHash}/${JOB_ID}/[A-Za-z0-9_-]{22}/source\\.m4a$`, "u"),
    );
    expect(key).not.toContain("identity-provider-subject");
  });

  it("rejects a nonce generator with the wrong byte count", async () => {
    await expect(
      createSourceKey(
        "identity-provider-subject",
        OWNER_SECRET,
        JOB_ID,
        "audio/mp4",
        () => new Uint8Array(15),
      ),
    ).rejects.toThrow("invalid byte count");
  });
});
