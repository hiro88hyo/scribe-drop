import type { OutputFormat } from "@scribe-drop/contracts";
import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MAX_ARTIFACT_PREVIEW_BYTES,
  ArtifactPreviewError,
  type ArtifactPreviewDependencies,
  requestArtifactPreview,
} from "./artifact-preview.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const R2_URL = `https://${"0".repeat(32)}.r2.cloudflarestorage.com/dummy/results/transcript.md`;

function responseFor(
  body: Uint8Array | string,
  format: OutputFormat = "markdown",
  headers: HeadersInit = {},
): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const contentTypes: Record<OutputFormat, string> = {
    json: "application/json",
    markdown: "text/markdown; charset=utf-8",
    srt: "application/x-subrip; charset=utf-8",
  };
  const responseHeaders = new Headers({
    "Cache-Control": "no-store",
    "Content-Length": String(bytes.byteLength),
    "Content-Type": contentTypes[format],
  });
  new Headers(headers).forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return new Response(Uint8Array.from(bytes).buffer, { headers: responseHeaders });
}

function dependencies(response: Response): ArtifactPreviewDependencies & {
  readonly fetchArtifact: Mock<ArtifactPreviewDependencies["fetchArtifact"]>;
  readonly getArtifact: Mock<ArtifactPreviewDependencies["getArtifact"]>;
} {
  return {
    fetchArtifact: vi.fn(() => Promise.resolve(response)),
    getArtifact: vi.fn(() =>
      Promise.resolve({
        expiresAt: "2027-01-01T00:05:00.000Z",
        url: R2_URL,
      }),
    ),
  };
}

describe("artifact preview", () => {
  it("fetches one exact R2 object without credentials or browser caching", async () => {
    const content = "# Dummy artifact\n";
    const deps = dependencies(responseFor(content));

    await expect(
      requestArtifactPreview(
        JOB_ID,
        "markdown",
        new TextEncoder().encode(content).byteLength,
        undefined,
        deps,
      ),
    ).resolves.toBe(content);

    expect(deps.getArtifact).toHaveBeenCalledWith(JOB_ID, "markdown", undefined);
    expect(deps.fetchArtifact).toHaveBeenCalledWith(
      R2_URL,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("rejects an oversized artifact before requesting a capability", async () => {
    const deps = dependencies(responseFor("unused"));

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", MAX_ARTIFACT_PREVIEW_BYTES + 1, undefined, deps),
    ).rejects.toMatchObject({ code: "oversized" });

    expect(deps.getArtifact).not.toHaveBeenCalled();
    expect(deps.fetchArtifact).not.toHaveBeenCalled();
  });

  it("rejects a capability outside the exact R2 account-host allowlist", async () => {
    const deps = dependencies(responseFor("unused"));
    deps.getArtifact.mockResolvedValue({
      expiresAt: "2027-01-01T00:05:00.000Z",
      url: "https://example.invalid/results/transcript.md",
    });

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 6, undefined, deps),
    ).rejects.toMatchObject({ code: "invalid_url" });

    expect(deps.fetchArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["different cache control", { "Cache-Control": "public" }, "cache_control_mismatch"],
    ["missing content length", { "Content-Length": "" }, "invalid_content_length"],
    ["different content length", { "Content-Length": "4" }, "size_mismatch"],
    ["different content type", { "Content-Type": "text/html" }, "content_type_mismatch"],
  ] as const)("rejects %s", async (_name, headers, code) => {
    const deps = dependencies(responseFor("hello", "markdown", headers));

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 5, undefined, deps),
    ).rejects.toMatchObject({ code });
  });

  it("cancels the response body when metadata validation fails", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
      },
    });
    const deps = dependencies(
      new Response(stream, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": "5",
          "Content-Type": "text/html",
        },
      }),
    );

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 5, undefined, deps),
    ).rejects.toMatchObject({ code: "content_type_mismatch" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a stream that exceeds the declared artifact size", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("too long"));
        controller.close();
      },
    });
    const deps = dependencies(
      new Response(stream, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": "5",
          "Content-Type": "text/markdown",
        },
      }),
    );

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 5, undefined, deps),
    ).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("rejects a stream that ends before the declared artifact size", async () => {
    const deps = dependencies(responseFor("short", "markdown", { "Content-Length": "8" }));

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 8, undefined, deps),
    ).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("replaces stream failures with a safe error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`remote stream failed at ${R2_URL}`));
      },
    });
    const deps = dependencies(
      new Response(stream, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": "5",
          "Content-Type": "text/markdown",
        },
      }),
    );

    const error = await requestArtifactPreview(JOB_ID, "markdown", 5, undefined, deps).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "fetch_failed" });
    expect(String(error)).not.toContain(R2_URL);
  });

  it("rejects malformed UTF-8 without exposing response bytes", async () => {
    const deps = dependencies(responseFor(new Uint8Array([0xc3, 0x28])));

    const error = await requestArtifactPreview(JOB_ID, "markdown", 2, undefined, deps).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ArtifactPreviewError);
    expect(error).toMatchObject({ code: "invalid_encoding" });
    expect(String(error)).not.toContain(R2_URL);
    expect(String(error)).not.toContain("Ã");
  });

  it("does not fetch when capability retrieval is aborted", async () => {
    const controller = new AbortController();
    const deps = dependencies(responseFor("unused"));
    deps.getArtifact.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({
        expiresAt: "2027-01-01T00:05:00.000Z",
        url: R2_URL,
      });
    });

    await expect(
      requestArtifactPreview(JOB_ID, "markdown", 6, controller.signal, deps),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(deps.fetchArtifact).not.toHaveBeenCalled();
  });
});
