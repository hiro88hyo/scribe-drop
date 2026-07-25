import { describe, expect, it } from "vitest";

import { PUBLIC_ERROR_CODES, PUBLIC_ERROR_DESCRIPTORS, getPublicErrorDescriptor } from "./index.js";

describe("public error descriptors", () => {
  it("defines a safe descriptor for every public error code", () => {
    expect(Object.keys(PUBLIC_ERROR_DESCRIPTORS).sort()).toEqual([...PUBLIC_ERROR_CODES].sort());
  });

  it("marks authentication failures as non-retryable", () => {
    expect(getPublicErrorDescriptor("UNAUTHENTICATED")).toEqual({
      httpStatus: 401,
      kind: "authentication",
      retryable: false,
    });
  });

  it("keeps processing failure details out of the public code", () => {
    expect(PUBLIC_ERROR_CODES).toContain("PROCESSING_FAILED");
    expect(PUBLIC_ERROR_CODES).not.toContain("FFPROBE_INVALID_CONTAINER");
  });
});
