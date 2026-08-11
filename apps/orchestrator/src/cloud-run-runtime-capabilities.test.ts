import { describe, expect, it, vi } from "vitest";

import { R2RuntimeCapabilityIssuer } from "./cloud-run-runtime-capabilities.js";
import type { RuntimeAttemptContext } from "./cloud-run-runtime-store.js";
import type { R2CapabilityIssuer } from "./r2-capability-issuer.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OWNER_HASH = "a".repeat(32);
const context: RuntimeAttemptContext = {
  attemptId: ATTEMPT_ID,
  cancelRequested: false,
  environment: "staging",
  executionHandle: "h".repeat(43),
  jobId: JOB_ID,
  options: {
    contractVersion: 2,
    language: "auto",
    model: "large-v3-turbo",
    outputFormats: ["markdown", "srt"],
    vad: true,
  },
  ownerHash: OWNER_HASH,
  sourceEtag: "synthetic-etag",
  sourceKey: `incoming/${OWNER_HASH}/${JOB_ID}/${"n".repeat(22)}/source.m4a`,
  sourceSizeBytes: 1024,
  status: "PENDING_BOOTSTRAP",
};

function issuer(expiresAt = "2026-08-11T02:00:00.000Z"): {
  readonly issue: ReturnType<typeof vi.fn<R2CapabilityIssuer["issue"]>>;
  readonly port: R2CapabilityIssuer;
} {
  const issue = vi.fn<R2CapabilityIssuer["issue"]>().mockResolvedValue({
    expiresAt,
    jsonPutUrl: "https://result.example.invalid/transcript.json",
    manifestPutUrl: "https://result.example.invalid/manifest.json",
    markdownPutUrl: "https://result.example.invalid/transcript.md",
    sourceGetUrl: "https://source.example.invalid/source.m4a",
    srtPutUrl: "https://result.example.invalid/transcript.srt",
  });
  return { issue, port: { issue } };
}

describe("Cloud Run R2 runtime capabilities", () => {
  it("issues only selected formats with exact attempt keys and source metadata", async () => {
    const selected = issuer();
    const adapter = new R2RuntimeCapabilityIssuer("recording-transcriber-staging", selected.port);
    await expect(
      adapter.issue({
        claimDigest: "c".repeat(43),
        context,
        expiresAt: "2026-08-11T00:55:00.000Z",
      }),
    ).resolves.toEqual({
      results: {
        artifacts: [
          {
            format: "markdown",
            key: `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/transcript.md`,
            putUrl: "https://result.example.invalid/transcript.md",
          },
          {
            format: "srt",
            key: `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/transcript.srt`,
            putUrl: "https://result.example.invalid/transcript.srt",
          },
        ],
        manifestPutUrl: "https://result.example.invalid/manifest.json",
      },
      source: {
        expectedEtag: "synthetic-etag",
        expectedSizeBytes: 1024,
        getUrl: "https://source.example.invalid/source.m4a",
      },
    });
    expect(selected.issue).toHaveBeenCalledWith({
      resultPrefix: `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/`,
      sourceBucket: "recording-transcriber-staging",
      sourceKey: context.sourceKey,
    });
  });

  it("rejects capabilities that expire before the session", async () => {
    const adapter = new R2RuntimeCapabilityIssuer(
      "recording-transcriber-staging",
      issuer("2026-08-11T00:30:00.000Z").port,
    );
    await expect(
      adapter.issue({
        claimDigest: "c".repeat(43),
        context,
        expiresAt: "2026-08-11T00:55:00.000Z",
      }),
    ).rejects.toThrow("R2 capability expires before the runtime session");
  });
});
