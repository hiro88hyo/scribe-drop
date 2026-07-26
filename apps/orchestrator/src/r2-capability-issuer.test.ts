import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { R2_CAPABILITY_TTL_SECONDS, createR2CapabilityIssuer } from "./r2-capability-issuer.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("R2 claim capability issuer", () => {
  it("signs one GET and four exact-object PUT operations for two hours", async () => {
    const sign = vi.fn(
      (command: GetObjectCommand | PutObjectCommand, expiresIn: number, _signingDate: Date) => {
        void _signingDate;
        return Promise.resolve(
          `https://storage.example.invalid/${String(command.input.Key)}?method=${
            command instanceof GetObjectCommand ? "GET" : "PUT"
          }&expires=${String(expiresIn)}`,
        );
      },
    );
    const issuer = createR2CapabilityIssuer({
      accessKeyId: "r2-access-key-placeholder",
      accountId: "0".repeat(32),
      now: () => NOW,
      secretAccessKey: "0000000000000000",
      sign,
    });

    const result = await issuer.issue({
      resultPrefix: `results/owner/${JOB_ID}/${ATTEMPT_ID}/`,
      sourceBucket: "recording-transcriber-test",
      sourceKey: `incoming/owner/${JOB_ID}/nonce/source.m4a`,
    });

    expect(result.expiresAt).toBe("2026-07-25T02:00:00.000Z");
    expect(sign).toHaveBeenCalledTimes(5);
    for (const [, expiresIn, signingDate] of sign.mock.calls) {
      expect(expiresIn).toBe(R2_CAPABILITY_TTL_SECONDS);
      expect(signingDate).toEqual(NOW);
    }
    expect(sign.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(
      1,
    );
    expect(sign.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(
      4,
    );
    expect(result.sourceGetUrl).toContain("method=GET");
    expect(result.markdownPutUrl).toContain("transcript.md?method=PUT");
    expect(result.jsonPutUrl).toContain("transcript.json?method=PUT");
    expect(result.srtPutUrl).toContain("transcript.srt?method=PUT");
    expect(result.manifestPutUrl).toContain("manifest.json?method=PUT");
  });

  it("rejects keys outside the fixed source and result prefixes before signing", async () => {
    const sign = vi.fn().mockResolvedValue("https://storage.example.invalid/signed");
    const issuer = createR2CapabilityIssuer({
      accessKeyId: "r2-access-key-placeholder",
      accountId: "0".repeat(32),
      secretAccessKey: "0000000000000000",
      sign,
    });

    await expect(
      issuer.issue({
        resultPrefix: "incoming/wrong-prefix/",
        sourceBucket: "recording-transcriber-test",
        sourceKey: "results/wrong-prefix/source.m4a",
      }),
    ).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it("produces R2 SigV4 URLs without a fixed empty-body checksum", async () => {
    const issuer = createR2CapabilityIssuer({
      accessKeyId: "r2-access-key-placeholder",
      accountId: "0".repeat(32),
      now: () => NOW,
      secretAccessKey: "0000000000000000",
    });

    const result = await issuer.issue({
      resultPrefix: `results/owner/${JOB_ID}/${ATTEMPT_ID}/`,
      sourceBucket: "recording-transcriber-test",
      sourceKey: `incoming/owner/${JOB_ID}/nonce/source.m4a`,
    });

    for (const signedUrl of [
      result.sourceGetUrl,
      result.markdownPutUrl,
      result.jsonPutUrl,
      result.srtPutUrl,
      result.manifestPutUrl,
    ]) {
      const url = new URL(signedUrl);
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("X-Amz-Expires")).toBe(String(R2_CAPABILITY_TTL_SECONDS));
      expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
      expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    }
  });
});
