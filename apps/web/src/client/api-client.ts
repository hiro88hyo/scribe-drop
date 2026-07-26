import {
  apiErrorResponseSchema,
  artifactDownloadResponseSchema,
  createJobRequestSchema,
  createJobResponseSchema,
  deleteJobResponseSchema,
  jobActionResponseSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  meResponseSchema,
  outputFormatSchema,
  ulidSchema,
  type ArtifactDownloadResponse,
  type CreateJobRequest,
  type CreateJobResponse,
  type DeleteJobResponse,
  type JobActionResponse,
  type JobDetail,
  type ListJobsResponse,
  type MeResponse,
  type OutputFormat,
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
  cancelJob(jobId: string, csrfToken: string, signal?: AbortSignal): Promise<JobActionResponse>;
  completeUpload(
    jobId: string,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<JobActionResponse>;
  createJob(
    input: CreateJobRequest,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<CreateJobResponse>;
  deleteJob(jobId: string, csrfToken: string, signal?: AbortSignal): Promise<DeleteJobResponse>;
  getJob(jobId: string, signal?: AbortSignal): Promise<JobDetail>;
  getArtifact(
    jobId: string,
    format: OutputFormat,
    signal?: AbortSignal,
  ): Promise<ArtifactDownloadResponse>;
  getMe(signal?: AbortSignal): Promise<MeResponse>;
  listJobs(
    input: {
      readonly cursor?: string;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<ListJobsResponse>;
  retryJob(jobId: string, csrfToken: string, signal?: AbortSignal): Promise<JobActionResponse>;
}

interface JsonRequestOptions {
  readonly body?: string;
  readonly csrfToken?: string;
  readonly method: "DELETE" | "GET" | "POST";
  readonly signal?: AbortSignal;
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
  options: JsonRequestOptions,
): Promise<Output> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.csrfToken !== undefined) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }

  let response: Response;
  try {
    response = await fetcher(path, {
      ...(options.body === undefined ? {} : { body: options.body }),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: options.method,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    async cancelJob(jobId, csrfToken, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      if (!idResult.success || csrfToken.length < 32 || csrfToken.length > 4096) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 400,
        });
      }
      return await requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}/cancel`,
        jobActionResponseSchema,
        {
          body: "{}",
          csrfToken,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },

    async completeUpload(jobId, csrfToken, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      if (!idResult.success || csrfToken.length < 32 || csrfToken.length > 4096) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 400,
        });
      }
      return await requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}/upload-complete`,
        jobActionResponseSchema,
        {
          body: "{}",
          csrfToken,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },

    async createJob(input, csrfToken, signal) {
      const inputResult = createJobRequestSchema.safeParse(input);
      if (!inputResult.success || csrfToken.length < 32 || csrfToken.length > 4096) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 400,
        });
      }
      return await requestJson(fetcher, "/api/jobs", createJobResponseSchema, {
        body: JSON.stringify(inputResult.data),
        csrfToken,
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      });
    },

    async deleteJob(jobId, csrfToken, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      if (!idResult.success || csrfToken.length < 32 || csrfToken.length > 4096) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 400,
        });
      }
      return await requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}`,
        deleteJobResponseSchema,
        {
          body: "{}",
          csrfToken,
          method: "DELETE",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },

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
        {
          method: "GET",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },

    getArtifact(jobId, format, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      const formatResult = outputFormatSchema.safeParse(format);
      if (!idResult.success || !formatResult.success) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 404,
        });
      }
      return requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}/artifacts/${formatResult.data}`,
        artifactDownloadResponseSchema,
        {
          method: "GET",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },

    getMe(signal) {
      return requestJson(fetcher, "/api/me", meResponseSchema, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
    },

    listJobs(input, signal) {
      const query = new URLSearchParams({
        limit: String(input.limit),
      });
      if (input.cursor !== undefined) {
        query.set("cursor", input.cursor);
      }
      return requestJson(fetcher, `/api/jobs?${query.toString()}`, listJobsResponseSchema, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
    },

    async retryJob(jobId, csrfToken, signal) {
      const idResult = ulidSchema.safeParse(jobId);
      if (!idResult.success || csrfToken.length < 32 || csrfToken.length > 4096) {
        throw new ApiClientError({
          kind: "invalid_request",
          status: 400,
        });
      }
      return await requestJson(
        fetcher,
        `/api/jobs/${encodeURIComponent(idResult.data)}/retry`,
        jobActionResponseSchema,
        {
          body: "{}",
          csrfToken,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },
  };
}

export const apiClient = createApiClient();
