import type { OutputFormat } from "@scribe-drop/contracts";

import {
  ApiClientError,
  apiClient,
  type ApiClientErrorKind,
  type ScribeDropApiClient,
} from "./api-client.js";

export const MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;

export type ArtifactPreviewErrorCode =
  | "cache_control_mismatch"
  | "content_type_mismatch"
  | "fetch_failed"
  | "http_failure"
  | "invalid_encoding"
  | "invalid_content_length"
  | "invalid_request"
  | "invalid_url"
  | "missing_body"
  | "oversized"
  | "size_mismatch";

export type ArtifactPreviewFailureCode =
  ArtifactPreviewErrorCode | `capability_${ApiClientErrorKind}` | "unexpected";

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

function parseContentLength(response: Response): number | undefined {
  const rawLength = response.headers.get("Content-Length");
  if (rawLength === null) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(rawLength)) {
    throw new ArtifactPreviewError("invalid_content_length");
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ArtifactPreviewError("invalid_content_length");
  }
  return contentLength;
}

function validateResponseMetadata(
  response: Response,
  format: OutputFormat,
  expectedSizeBytes: number,
): void {
  if (!response.ok) {
    throw new ArtifactPreviewError("http_failure");
  }
  if (response.body === null) {
    throw new ArtifactPreviewError("missing_body");
  }
  if (response.headers.get("Cache-Control")?.trim().toLowerCase() !== "no-store") {
    throw new ArtifactPreviewError("cache_control_mismatch");
  }
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== expectedContentTypes[format]) {
    throw new ArtifactPreviewError("content_type_mismatch");
  }
  const contentLength = parseContentLength(response);
  if (contentLength !== undefined && contentLength > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new ArtifactPreviewError("oversized");
  }
  if (contentLength !== undefined && contentLength !== expectedSizeBytes) {
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
    throw new ArtifactPreviewError("missing_body");
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

export function artifactPreviewFailureCode(error: unknown): ArtifactPreviewFailureCode {
  if (error instanceof ArtifactPreviewError) {
    return error.code;
  }
  if (error instanceof ApiClientError) {
    return `capability_${error.kind}`;
  }
  return "unexpected";
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
