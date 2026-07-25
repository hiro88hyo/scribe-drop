import { ulidSchema } from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import { decodeJobCursor, encodeJobCursor } from "../src/server/jobs/job-cursor.js";
import { createSourceKey } from "../src/server/jobs/job-source-key.js";
import { createUlid } from "../src/server/id/ulid.js";

describe("job identifiers and cursors", () => {
  it("generates a valid time-sortable ULID from exactly 80 random bits", () => {
    const earlier = createUlid(1_700_000_000_000, (length) => new Uint8Array(length));
    const later = createUlid(1_700_000_000_001, (length) => new Uint8Array(length).fill(255));

    expect(ulidSchema.parse(earlier)).toBe(earlier);
    expect(ulidSchema.parse(later)).toBe(later);
    expect(earlier < later).toBe(true);
    expect(() => createUlid(0, () => new Uint8Array(9))).toThrow();
  });

  it("round-trips a validated cursor and rejects modified payloads", () => {
    const cursor = {
      createdAt: "2027-01-01T00:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const encoded = encodeJobCursor(cursor);

    expect(decodeJobCursor(encoded)).toEqual(cursor);
    expect(decodeJobCursor("not+a+base64url+cursor")).toBeUndefined();
  });

  it("keeps all user-controlled values out of the final source key", async () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const key = await createSourceKey(
      "access-subject",
      "test-owner-hash-secret-at-least-32-bytes",
      id,
      "audio/mp4",
      (length) => new Uint8Array(length).fill(7),
    );

    expect(key).toMatch(
      /^incoming\/[0-9a-f]{32}\/01ARZ3NDEKTSV4RRFFQ69G5FAV\/[A-Za-z0-9_-]{22}\/source\.m4a$/u,
    );
    expect(key).not.toContain("access-subject");
  });
});
