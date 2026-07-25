import {
  apiErrorResponseSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  meResponseSchema,
  ulidSchema,
  type JobDetail,
  type ListJobsResponse,
  type MeResponse,
  type PublicErrorCode,
} from "@scribe-drop/contracts";
import type { ZodType } from "zod";

const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const GENERIC_API_ERROR_MESSAGE = "データを読み込めませんでした。";

export type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ApiClientErrorKind = "api" | "invalid_request" | "invalid_response" | "network";

interface ApiClientErrorOptions {
  readonly code?: PublicErrorCode;
  readonly kind: ApiClientErrorKind;
  readonly requestId?: string;
  readonly status: number;
}

export class ApiClientError extends Error {
  readonly code: PublicErrorCode | undefined;
  readonly kind: ApiClientErrorKind;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: ApiClientErrorOptions) {
    super(GENERIC_API_ERROR_MESSAGE);
    this.name = "ApiClientError";
    this.code = options.code;
    this.kind = options.kind;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

export interface ScribeDropApiClient {
  getJob(jobId: string, signal?: AbortSignal): Promise<JobDetail>;
  getMe(signal?: AbortSignal): Promise<MeResponse>;
  listJobs(
    input: {
      readonly cursor?: string;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<ListJobsResponse>;
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") === true
  );
}

function exceedsDeclaredResponseLimit(response: Response): boolean {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength === null) {
    return false;
  }
  if (!/^\d+$/u.test(contentLength)) {
    return true;
  }
  return Number(contentLength) > MAX_API_RESPONSE_BYTES;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (!isJsonResponse(response) || exceedsDeclaredResponseLimit(response)) {
    throw new ApiClientError({
      kind: "invalid_response",
      status: response.status,
    });
  }

  const text = await response.text();
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_API_RESPONSE_BYTES) {
    throw new ApiClientError({
      kind: "invalid_response",
      status: response.status,
    });
  }

  try {
    const body: unknown = JSON.parse(text);
    return body;
  } catch {
    throw new ApiClientError({
      kind: "invalid_response",
      status: response.status,
    });
  }
}

async function requestJson<Output>(
  fetcher: ApiFetch,
  path: string,
  schema: ZodType<Output>,
  signal?: AbortSignal,
): Promise<Output> {
  let response: Response;
  try {
    response = await fetcher(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiClientError({
      kind: "network",
      status: 0,
    });
  }

  const untrustedBody = await readResponseBody(response);
  if (!response.ok) {
    const errorResult = apiErrorResponseSchema.safeParse(untrustedBody);
    if (!errorResult.success) {
      throw new ApiClientError({
        kind: "invalid_response",
        status: response.status,
      });
    }
    throw new ApiClientError({
      code: errorResult.data.error.code,
      kind: "api",
      requestId: errorResult.data.error.requestId,
      status: response.status,
    });
  }

  const result = schema.safeParse(untrustedBody);
  if (!result.success) {
    throw new ApiClientError({
      kind: "invalid_response",
      status: response.status,
    });
  }
  return result.data;
}

export function createApiClient(fetcher: ApiFetch = globalThis.fetch): ScribeDropApiClient {
  return {
    async getJob(jobId, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      if (!idResult.success) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 404,
        });
      }
      return requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}`,
        jobDetailSchema,
        signal,
      );
    },

    getMe(signal) {
      return requestJson(fetcher, "/api/me", meResponseSchema, signal);
    },

    listJobs(input, signal) {
      const query = new URLSearchParams({
        limit: String(input.limit),
      });
      if (input.cursor !== undefined) {
        query.set("cursor", input.cursor);
      }
      return requestJson(fetcher, `/api/jobs?${query.toString()}`, listJobsResponseSchema, signal);
    },
  };
}

export const apiClient = createApiClient();
