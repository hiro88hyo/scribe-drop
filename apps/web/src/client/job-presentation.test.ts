import { JOB_STATUSES } from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import { ApiClientError } from "./api-client.js";
import {
  formatByteSize,
  formatDateTime,
  formatDuration,
  formatLanguage,
  formatOutputFormats,
  getJobActionAvailability,
  getStatusPresentation,
  toUiError,
} from "./job-presentation.js";

describe("job presentation", () => {
  it("provides a deliberate user-facing label for every job status", () => {
    for (const status of JOB_STATUSES) {
      const presentation = getStatusPresentation(status);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(["cancelled", "complete", "error", "progress", "waiting"]).toContain(
        presentation.tone,
      );
    }
  });

  it("exposes only valid retry and cancellation actions for every status", () => {
    for (const status of JOB_STATUSES) {
      const availability = getJobActionAvailability(status);
      expect(availability.canRetry).toBe(status === "FAILED");
      expect(availability.canCancel).toBe(
        [
          "CREATED",
          "UPLOADING",
          "UPLOADED",
          "SUBMISSION_PENDING",
          "SUBMITTING",
          "RUNNING",
        ].includes(status),
      );
    }
  });

  it("formats byte size, duration, language and output formats", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1536)).toBe("1.5 KiB");
    expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe("2 GiB");
    expect(formatDuration(7)).toBe("7秒");
    expect(formatDuration(67)).toBe("1分7秒");
    expect(formatDuration(3661)).toBe("1時間1分1秒");
    expect(formatLanguage("ja")).toBe("日本語");
    expect(formatLanguage("en")).toBe("英語");
    expect(formatLanguage("auto")).toBe("自動判定");
    expect(formatOutputFormats(["markdown", "srt", "json"])).toBe("Markdown・SRT・JSON");
  });

  it("formats UTC timestamps in the requested display timezone", () => {
    const formatted = formatDateTime("2027-01-01T00:10:00.000Z", "Asia/Tokyo");

    expect(formatted).toContain("2027");
    expect(formatted).toContain("9:10");
  });

  it("maps errors without exposing raw exception details", () => {
    const invalidResponse = new ApiClientError({
      kind: "invalid_response",
      status: 200,
    });
    const authenticatedError = new ApiClientError({
      code: "UNAUTHENTICATED",
      kind: "api",
      requestId: "request-id",
      status: 401,
    });

    expect(toUiError(new Error("raw-secret-detail")).message).not.toContain("raw-secret-detail");
    expect(toUiError(invalidResponse).message).toContain("正しい応答");
    expect(toUiError(authenticatedError)).toEqual({
      message: "認証の有効期限が切れました。ページを再読み込みしてください。",
      requestId: "request-id",
    });
  });
});
