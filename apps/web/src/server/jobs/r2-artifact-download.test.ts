import { describe, expect, it } from "vitest";

import { ARTIFACT_DOWNLOAD_TTL_SECONDS, createArtifactDownload } from "./r2-artifact-download.js";

describe("R2 artifact download", () => {
  it("signs one exact GET object for five minutes", async () => {
    const now = new Date("2027-01-01T00:00:00.000Z");
    const key =
      "results/0123456789abcdef0123456789abcdef/01ARZ3NDEKTSV4RRFFQ69G5FAV/01ARZ3NDEKTSV4RRFFQ69G5FAW/transcript.md";
    const result = await createArtifactDownload({
      accountId: "0".repeat(32),
      bucket: "recording-transcriber-test",
      key,
      now,
      parentAccessKeyId: "test-only-access-key",
      parentSecretAccessKey: "test-only-secret-key-with-32-bytes",
    });

    expect(result.expiresAt).toBe(
      new Date(now.getTime() + ARTIFACT_DOWNLOAD_TTL_SECONDS * 1_000).toISOString(),
    );
    const url = new URL(result.url);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe(`/recording-transcriber-test/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(url.searchParams.get("response-cache-control")).toBe("no-store");
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
  });
});
