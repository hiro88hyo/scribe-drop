import { describe, expect, it, vi } from "vitest";

import { requestArtifactDownload } from "./artifact-download.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("artifact download", () => {
  it("requests a fresh capability and hands it directly to the browser download boundary", async () => {
    const getArtifact = vi.fn(() =>
      Promise.resolve({
        expiresAt: "2027-01-01T00:05:00.000Z",
        url: "https://storage.example.test/download?signature=test-only",
      }),
    );
    const startDownload = vi.fn();

    await expect(
      requestArtifactDownload(JOB_ID, "markdown", undefined, {
        getArtifact,
        startDownload,
      }),
    ).resolves.toBe(true);

    expect(getArtifact).toHaveBeenCalledWith(JOB_ID, "markdown", undefined);
    expect(startDownload).toHaveBeenCalledOnce();
    expect(startDownload).toHaveBeenCalledWith(
      "https://storage.example.test/download?signature=test-only",
    );
  });

  it("does not start a download when the request was aborted before its response is consumed", async () => {
    const controller = new AbortController();
    const startDownload = vi.fn();

    await expect(
      requestArtifactDownload(JOB_ID, "srt", controller.signal, {
        getArtifact: () => {
          controller.abort();
          return Promise.resolve({
            expiresAt: "2027-01-01T00:05:00.000Z",
            url: "https://storage.example.test/download?signature=test-only",
          });
        },
        startDownload,
      }),
    ).resolves.toBe(false);

    expect(startDownload).not.toHaveBeenCalled();
  });
});
