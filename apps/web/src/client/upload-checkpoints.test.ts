import { describe, expect, it } from "vitest";

import { uploadCheckpointSchema } from "./upload-checkpoints.js";

const CHECKPOINT = {
  contentType: "audio/mp4",
  filename: "recording.m4a",
  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sizeBytes: 1024,
  status: "uploading",
  updatedAt: "2027-01-01T00:00:00.000Z",
  uploadedBytes: 512,
} as const;

describe("upload checkpoint boundary", () => {
  it("accepts metadata without storing the File or upload credentials", () => {
    expect(uploadCheckpointSchema.parse(CHECKPOINT)).toEqual(CHECKPOINT);
  });

  it("rejects credentials, object keys, and impossible progress", () => {
    expect(
      uploadCheckpointSchema.safeParse({
        ...CHECKPOINT,
        sessionToken: "must-not-be-persisted",
      }).success,
    ).toBe(false);
    expect(
      uploadCheckpointSchema.safeParse({
        ...CHECKPOINT,
        key: "incoming/secret-capability",
      }).success,
    ).toBe(false);
    expect(
      uploadCheckpointSchema.safeParse({
        ...CHECKPOINT,
        title: "must-not-be-persisted",
      }).success,
    ).toBe(false);
    expect(
      uploadCheckpointSchema.safeParse({
        ...CHECKPOINT,
        uploadedBytes: CHECKPOINT.sizeBytes + 1,
      }).success,
    ).toBe(false);
  });
});
