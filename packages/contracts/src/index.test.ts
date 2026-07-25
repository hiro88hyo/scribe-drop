import { describe, expect, it } from "vitest";

import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  createJobRequestSchema,
  type CreateJobRequest,
} from "./index.js";

const validRequest = {
  contentType: "audio/mp4",
  filename: "recording.m4a",
  options: {
    language: "ja",
    model: "large-v3-turbo",
    outputFormats: ["markdown", "json", "srt"],
    vad: true,
  },
  sizeBytes: 12_345_678,
  title: "週次定例",
} satisfies CreateJobRequest;

describe("createJobRequestSchema", () => {
  it("accepts the documented request and exact upper boundaries", () => {
    expect(
      createJobRequestSchema.safeParse({
        ...validRequest,
        sizeBytes: MAX_FILE_SIZE_BYTES,
        title: "a".repeat(MAX_JOB_TITLE_LENGTH),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["oversized file", { ...validRequest, sizeBytes: MAX_FILE_SIZE_BYTES + 1 }],
    ["blank title", { ...validRequest, title: "   " }],
    [
      "long title",
      {
        ...validRequest,
        title: "a".repeat(MAX_JOB_TITLE_LENGTH + 1),
      },
    ],
    ["unsupported MIME", { ...validRequest, contentType: "application/octet-stream" }],
    [
      "unsupported model",
      {
        ...validRequest,
        options: { ...validRequest.options, model: "latest" },
      },
    ],
    [
      "duplicate output",
      {
        ...validRequest,
        options: {
          ...validRequest.options,
          outputFormats: ["json", "json"],
        },
      },
    ],
    [
      "unknown field",
      {
        ...validRequest,
        admin: true,
      },
    ],
  ])("rejects %s", (_caseName, request) => {
    expect(createJobRequestSchema.safeParse(request).success).toBe(false);
  });
});
