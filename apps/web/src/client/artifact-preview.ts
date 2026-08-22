import type { OutputFormat } from "@scribe-drop/contracts";

import { apiClient, type ScribeDropApiClient } from "./api-client.js";

export const MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;

export type ArtifactPreviewErrorCode =
  | "fetch_failed"
  | "invalid_encoding"
  | "invalid_request"
  | "invalid_response"
  | "invalid_url"
  | "oversized"
  | "size_mismatch";

export class ArtifactPreviewError extends Error {
  readonly code: ArtifactPreviewErrorCode;

  constructor(code: ArtifactPreviewErrorCode) {
    super("Artifact preview is unavailable");
    this.name = "ArtifactPreviewError";
    this.code = code;
  }
}

export interface ArtifactPreviewDependencies {
  readonly fetchArtifact: (url: string, init: RequestInit) => Promise<Response>;
  readonly getArtifact: ScribeDropApiClient["getArtifact"];
}

const expectedContentTypes: Readonly<Record<OutputFormat, string>> = {
  json: "application/json",
  markdown: "text/markdown",
  srt: "application/x-subrip",
};

const r2AccountHostPattern = /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/u;

const defaultDependencies: ArtifactPreviewDependencies = {
  fetchArtifact: (url, init) => fetch(url, init),
  getArtifact: apiClient.getArtifact.bind(apiClient),
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function validateCapabilityUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactPreviewError("invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !r2AccountHostPattern.test(url.hostname)
  ) {
    throw new ArtifactPreviewError("invalid_url");
  }
  return url.href;
}

function parseContentLength(response: Response): number {
  const rawLength = response.headers.get("Content-Length");
  if (rawLength === null || !/^(0|[1-9][0-9]*)$/u.test(rawLength)) {
    throw new ArtifactPreviewError("invalid_response");
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ArtifactPreviewError("invalid_response");
  }
  return contentLength;
}

function validateResponseMetadata(
  response: Response,
  format: OutputFormat,
  expectedSizeBytes: number,
): void {
  if (!response.ok || response.body === null) {
    throw new ArtifactPreviewError("invalid_response");
  }
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== expectedContentTypes[format]) {
    throw new ArtifactPreviewError("invalid_response");
  }
  const contentLength = parseContentLength(response);
  if (contentLength > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new ArtifactPreviewError("oversized");
  }
  if (contentLength !== expectedSizeBytes) {
    throw new ArtifactPreviewError("size_mismatch");
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // The validation failure remains authoritative when cancellation itself fails.
  }
}

async function readBoundedUtf8(response: Response, expectedSizeBytes: number): Promise<string> {
  if (response.body === null) {
    throw new ArtifactPreviewError("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > expectedSizeBytes || byteLength > MAX_ARTIFACT_PREVIEW_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if the remote stream cannot be cancelled.
        }
        throw new ArtifactPreviewError("size_mismatch");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    if (
      error instanceof ArtifactPreviewError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    throw new ArtifactPreviewError("fetch_failed");
  } finally {
    reader.releaseLock();
  }
  if (byteLength !== expectedSizeBytes) {
    throw new ArtifactPreviewError("size_mismatch");
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactPreviewError("invalid_encoding");
  }
}

export async function requestArtifactPreview(
  jobId: string,
  format: OutputFormat,
  expectedSizeBytes: number,
  signal?: AbortSignal,
  dependencies: ArtifactPreviewDependencies = defaultDependencies,
): Promise<string> {
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
    throw new ArtifactPreviewError("invalid_request");
  }
  if (expectedSizeBytes > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new ArtifactPreviewError("oversized");
  }

  throwIfAborted(signal);
  const capability = await dependencies.getArtifact(jobId, format, signal);
  throwIfAborted(signal);
  const url = validateCapabilityUrl(capability.url);

  let response: Response;
  try {
    response = await dependencies.fetchArtifact(url, {
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ArtifactPreviewError("fetch_failed");
  }

  try {
    validateResponseMetadata(response, format, expectedSizeBytes);
  } catch (error: unknown) {
    await cancelResponseBody(response);
    throw error;
  }
  return readBoundedUtf8(response, expectedSizeBytes);
}
