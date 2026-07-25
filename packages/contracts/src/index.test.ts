import { describe, expect, it } from "vitest";

import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  MAX_RECORDING_DURATION_SECONDS,
  createJobRequestSchema,
  jobSummarySchema,
  uploadCompleteRequestSchema,
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

describe("jobSummarySchema", () => {
  const validSummary = {
    actualSizeBytes: null,
    completedAt: null,
    createdAt: "2027-01-01T00:00:00.000Z",
    durationSeconds: null,
    errorCode: null,
    expectedSizeBytes: 1024,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    originalFilename: "recording.m4a",
    sourceContentType: "audio/mp4",
    status: "CREATED",
    title: "週次定例",
    updatedAt: "2027-01-01T00:00:00.000Z",
  };

  it("accepts an unknown duration and the documented eight-hour boundary", () => {
    expect(jobSummarySchema.safeParse(validSummary).success).toBe(true);
    expect(
      jobSummarySchema.safeParse({
        ...validSummary,
        durationSeconds: MAX_RECORDING_DURATION_SECONDS,
      }).success,
    ).toBe(true);
  });

  it("rejects a duration beyond the recording limit", () => {
    expect(
      jobSummarySchema.safeParse({
        ...validSummary,
        durationSeconds: MAX_RECORDING_DURATION_SECONDS + 0.001,
      }).success,
    ).toBe(false);
  });
});

describe("uploadCompleteRequestSchema", () => {
  it("accepts only an empty notification body", () => {
    expect(uploadCompleteRequestSchema.safeParse({}).success).toBe(true);
    expect(uploadCompleteRequestSchema.safeParse({ etag: "browser-observed" }).success).toBe(false);
    expect(uploadCompleteRequestSchema.safeParse({ sizeBytes: 1024 }).success).toBe(false);
  });
});
