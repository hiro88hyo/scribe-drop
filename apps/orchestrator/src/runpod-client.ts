import {
  runpodRunRequestSchema,
  runpodRunResponseSchema,
  runpodStatusResponseSchema,
  type RunpodRunRequest,
  type RunpodStatusResponse,
} from "@scribe-drop/contracts";

import { resolvePlatformFetch } from "./platform-fetch.js";

const RUNPOD_API_ORIGIN = "https://api.runpod.ai";
const RUNPOD_SUBMISSION_TIMEOUT_MS = 15_000;
const RUNPOD_CONTROL_TIMEOUT_MS = 15_000;
const MAX_RUNPOD_RESPONSE_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RunpodSubmissionResult =
  | {
      readonly outcome: "accepted";
      readonly runpodJobId: string;
    }
  | {
      readonly outcome: "rejected";
    }
  | {
      readonly outcome: "unknown";
      readonly reason: "request_failed" | "response_invalid";
    };

export interface RunpodSubmissionClient {
  submit(request: RunpodRunRequest): Promise<RunpodSubmissionResult>;
}

export type RunpodStatusFetchResult =
  | {
      readonly outcome: "found";
      readonly response: RunpodStatusResponse;
    }
  | {
      readonly outcome: "invalid_response" | "not_found" | "unavailable";
    };

export type RunpodCancelResult =
  | {
      readonly outcome: "accepted" | "not_found";
    }
  | {
      readonly outcome: "rejected" | "unavailable";
    };

export interface RunpodControlClient {
  cancel(runpodJobId: string): Promise<RunpodCancelResult>;
  getStatus(runpodJobId: string): Promise<RunpodStatusFetchResult>;
}

export interface RunpodClient extends RunpodSubmissionClient, RunpodControlClient {}

export interface RunpodClientOptions {
  readonly apiKey: string;
  readonly endpointId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RUNPOD_RESPONSE_BYTES)
  ) {
    return undefined;
  }
  try {
    if (response.body === null) {
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    do {
      const result: unknown = await reader.read();
      if (!isRecord(result) || typeof result["done"] !== "boolean") {
        return undefined;
      }
      if (result["done"]) {
        done = true;
        continue;
      }
      const value = result["value"];
      if (!(value instanceof Uint8Array)) {
        return undefined;
      }
      size += value.byteLength;
      if (size > MAX_RUNPOD_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    } while (!done);
    if (size === 0) {
      return undefined;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

export function createRunpodClient(options: RunpodClientOptions): RunpodClient {
  const fetchImplementation = resolvePlatformFetch(options.fetch);
  const timeoutMilliseconds = options.timeoutMilliseconds ?? RUNPOD_SUBMISSION_TIMEOUT_MS;
  const runUrl = `${RUNPOD_API_ORIGIN}/v2/${encodeURIComponent(options.endpointId)}/run`;
  const jobUrl = (runpodJobId: string, operation: "cancel" | "status"): string =>
    `${RUNPOD_API_ORIGIN}/v2/${encodeURIComponent(options.endpointId)}/${operation}/${encodeURIComponent(
      runpodJobId,
    )}`;
  const headers = {
    accept: "application/json",
    "accept-encoding": "gzip",
    authorization: `Bearer ${options.apiKey}`,
  };

  return {
    async cancel(runpodJobId) {
      let response: Response;
      try {
        response = await fetchImplementation(jobUrl(runpodJobId, "cancel"), {
          headers,
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMilliseconds ?? RUNPOD_CONTROL_TIMEOUT_MS),
        });
      } catch {
        return { outcome: "unavailable" };
      }
      if (response.status === 404) {
        return { outcome: "not_found" };
      }
      if (response.ok) {
        return { outcome: "accepted" };
      }
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? { outcome: "unavailable" }
        : { outcome: "rejected" };
    },

    async getStatus(runpodJobId) {
      let response: Response;
      try {
        response = await fetchImplementation(jobUrl(runpodJobId, "status"), {
          headers,
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMilliseconds ?? RUNPOD_CONTROL_TIMEOUT_MS),
        });
      } catch {
        return { outcome: "unavailable" };
      }
      if (response.status === 404) {
        return { outcome: "not_found" };
      }
      if (!response.ok) {
        return { outcome: "unavailable" };
      }
      const untrusted = await readBoundedJson(response);
      const parsed = runpodStatusResponseSchema.safeParse(untrusted);
      return parsed.success
        ? { outcome: "found", response: parsed.data }
        : { outcome: "invalid_response" };
    },

    async submit(untrustedRequest) {
      const request = runpodRunRequestSchema.parse(untrustedRequest);
      let response: Response;
      try {
        response = await fetchImplementation(runUrl, {
          body: JSON.stringify(request),
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        return { outcome: "unknown", reason: "request_failed" };
      }

      if (!response.ok) {
        return { outcome: "rejected" };
      }

      try {
        const parsed = runpodRunResponseSchema.safeParse(await readBoundedJson(response));
        return parsed.success
          ? { outcome: "accepted", runpodJobId: parsed.data.id }
          : { outcome: "unknown", reason: "response_invalid" };
      } catch {
        return { outcome: "unknown", reason: "response_invalid" };
      }
    },
  };
}
