import {
  apiErrorResponseSchema,
  createJobResponseSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  meResponseSchema,
  type JobDetail,
} from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import { ApiClientError, createApiClient, type ApiFetch } from "./api-client.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST_ID = "00000000-0000-4000-8000-000000000020";
const CSRF_TOKEN = "test-only-csrf-token-with-at-least-32-characters";

const JOB_DETAIL = {
  actualSizeBytes: null,
  artifacts: [],
  completedAt: null,
  createdAt: "2027-01-01T00:00:00.000Z",
  durationSeconds: null,
  errorCode: null,
  expectedSizeBytes: 1024,
  id: JOB_ID,
  options: {
    language: "ja",
    model: "large-v3-turbo",
    outputFormats: ["markdown", "json"],
    vad: true,
  },
  originalFilename: "recording.m4a",
  sourceContentType: "audio/mp4",
  status: "CREATED",
  title: "Weekly meeting",
  updatedAt: "2027-01-01T00:00:00.000Z",
} satisfies JobDetail;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("browser API client", () => {
  it("loads /api/me with same-origin credentials and no browser cache", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: ApiFetch = (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          csrfToken: "test-only-csrf-token-with-at-least-32-characters",
          user: {
            email: "user@example.test",
            sub: "owner-sub",
          },
        }),
      );
    };

    const result = await createApiClient(fetcher).getMe();

    expect(meResponseSchema.parse(result).user.email).toBe("user@example.test");
    expect(capturedInput).toBe("/api/me");
    expect(capturedInit).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
    });
  });

  it("validates and creates a job with JSON, CSRF, and same-origin credentials", async () => {
    let capturedBody: unknown;
    let capturedInit: RequestInit | undefined;
    const upload = {
      accessKeyId: "temporary-access-key",
      bucket: "recording-transcriber-test",
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      expiresAt: "2027-01-01T00:15:00.000Z",
      key: `incoming/0123456789abcdef0123456789abcdef/${JOB_ID}/nonce/source.m4a`,
      region: "auto",
      secretAccessKey: "temporary-secret-key",
      sessionToken: "temporary-session-token",
    } as const;
    const fetcher: ApiFetch = (_input, init) => {
      capturedInit = init;
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized JSON request body");
      }
      capturedBody = JSON.parse(init.body);
      return Promise.resolve(jsonResponse({ jobId: JOB_ID, upload }, 201));
    };

    const result = await createApiClient(fetcher).createJob(
      {
        contentType: "audio/mp4",
        filename: "recording.m4a",
        options: JOB_DETAIL.options,
        sizeBytes: 1024,
        title: "Weekly meeting",
      },
      CSRF_TOKEN,
    );

    expect(createJobResponseSchema.parse(result)).toEqual({ jobId: JOB_ID, upload });
    expect(capturedBody).toMatchObject({
      filename: "recording.m4a",
      sizeBytes: 1024,
      title: "Weekly meeting",
    });
    expect(capturedInit).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": CSRF_TOKEN,
      },
      method: "POST",
    });
  });

  it("notifies upload completion without sending browser-observed object metadata", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: ApiFetch = (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          job: {
            actualSizeBytes: 1024,
            completedAt: JOB_DETAIL.completedAt,
            createdAt: JOB_DETAIL.createdAt,
            durationSeconds: JOB_DETAIL.durationSeconds,
            errorCode: JOB_DETAIL.errorCode,
            expectedSizeBytes: JOB_DETAIL.expectedSizeBytes,
            id: JOB_DETAIL.id,
            originalFilename: JOB_DETAIL.originalFilename,
            sourceContentType: JOB_DETAIL.sourceContentType,
            status: "UPLOADED",
            title: JOB_DETAIL.title,
            updatedAt: JOB_DETAIL.updatedAt,
          },
        }),
      );
    };

    const result = await createApiClient(fetcher).completeUpload(JOB_ID, CSRF_TOKEN);

    expect(result.job).toMatchObject({
      actualSizeBytes: 1024,
      id: JOB_ID,
      status: "UPLOADED",
    });
    expect(capturedInput).toBe(`/api/jobs/${JOB_ID}/upload-complete`);
    expect(capturedInit).toMatchObject({
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": CSRF_TOKEN,
      },
      method: "POST",
    });
  });

  it("requests a fresh retry with an empty strict body and CSRF token", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: ApiFetch = (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          job: {
            actualSizeBytes: 1024,
            completedAt: null,
            createdAt: JOB_DETAIL.createdAt,
            durationSeconds: null,
            errorCode: null,
            expectedSizeBytes: JOB_DETAIL.expectedSizeBytes,
            id: JOB_DETAIL.id,
            originalFilename: JOB_DETAIL.originalFilename,
            sourceContentType: JOB_DETAIL.sourceContentType,
            status: "SUBMISSION_PENDING",
            title: JOB_DETAIL.title,
            updatedAt: JOB_DETAIL.updatedAt,
          },
        }),
      );
    };

    const result = await createApiClient(fetcher).retryJob(JOB_ID, CSRF_TOKEN);

    expect(result.job).toMatchObject({
      errorCode: null,
      id: JOB_ID,
      status: "SUBMISSION_PENDING",
    });
    expect(capturedInput).toBe(`/api/jobs/${JOB_ID}/retry`);
    expect(capturedInit).toMatchObject({
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": CSRF_TOKEN,
      },
      method: "POST",
    });
  });

  it("requests cancellation with an empty strict body and CSRF token", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: ApiFetch = (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          job: {
            actualSizeBytes: 1024,
            completedAt: null,
            createdAt: JOB_DETAIL.createdAt,
            durationSeconds: null,
            errorCode: null,
            expectedSizeBytes: JOB_DETAIL.expectedSizeBytes,
            id: JOB_DETAIL.id,
            originalFilename: JOB_DETAIL.originalFilename,
            sourceContentType: JOB_DETAIL.sourceContentType,
            status: "CANCEL_REQUESTED",
            title: JOB_DETAIL.title,
            updatedAt: JOB_DETAIL.updatedAt,
          },
        }),
      );
    };

    const result = await createApiClient(fetcher).cancelJob(JOB_ID, CSRF_TOKEN);

    expect(result.job.status).toBe("CANCEL_REQUESTED");
    expect(capturedInput).toBe(`/api/jobs/${JOB_ID}/cancel`);
    expect(capturedInit).toMatchObject({
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": CSRF_TOKEN,
      },
      method: "POST",
    });
  });

  it("requests an allowlisted artifact format without caching", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: ApiFetch = (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          expiresAt: "2027-01-01T00:05:00.000Z",
          url: "https://storage.example.test/download?signature=test-only",
        }),
      );
    };
    const client = createApiClient(fetcher);

    await expect(client.getArtifact(JOB_ID, "markdown")).resolves.toMatchObject({
      expiresAt: "2027-01-01T00:05:00.000Z",
    });
    expect(capturedInput).toBe(`/api/jobs/${JOB_ID}/artifacts/markdown`);
    expect(capturedInit).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
    });
  });

  it("rejects invalid create input and CSRF before issuing a request", async () => {
    let fetchCalls = 0;
    const client = createApiClient(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({}));
    });
    const input = {
      contentType: "audio/mp4",
      filename: "recording.m4a",
      options: JOB_DETAIL.options,
      sizeBytes: 1024,
      title: "Weekly meeting",
    } as const;

    await expect(client.createJob(input, "short")).rejects.toMatchObject({
      kind: "invalid_request",
      status: 400,
    });
    await expect(
      client.createJob({ ...input, sizeBytes: 2 * 1024 * 1024 * 1024 + 1 }, CSRF_TOKEN),
    ).rejects.toMatchObject({
      kind: "invalid_request",
      status: 400,
    });
    expect(fetchCalls).toBe(0);
  });

  it("encodes an opaque cursor and validates list and detail responses", async () => {
    const requestedPaths: string[] = [];
    const fetcher: ApiFetch = (input) => {
      requestedPaths.push(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      return Promise.resolve(
        requestedPaths.length === 1
          ? jsonResponse({
              items: [],
              nextCursor: null,
            })
          : jsonResponse(JOB_DETAIL),
      );
    };
    const client = createApiClient(fetcher);

    const list = await client.listJobs({ cursor: "cursor/with+symbols=", limit: 25 });
    const detail = await client.getJob(JOB_ID);

    expect(listJobsResponseSchema.parse(list)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(jobDetailSchema.parse(detail).id).toBe(JOB_ID);
    expect(requestedPaths).toEqual([
      "/api/jobs?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
      `/api/jobs/${JOB_ID}`,
    ]);
  });

  it("rejects an invalid route ID before issuing a request", async () => {
    let fetchCalls = 0;
    const client = createApiClient(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse(JOB_DETAIL));
    });

    await expect(client.getJob("../../another-user")).rejects.toMatchObject({
      kind: "invalid_request",
      status: 404,
    });
    expect(fetchCalls).toBe(0);
  });

  it("does not expose malformed success or server error bodies", async () => {
    const malformedClient = createApiClient(() =>
      Promise.resolve(jsonResponse({ internal: "database-secret-detail" })),
    );
    const errorBody = apiErrorResponseSchema.parse({
      error: {
        code: "INTERNAL_ERROR",
        message: "database-secret-detail",
        requestId: REQUEST_ID,
      },
    });
    const failedClient = createApiClient(() => Promise.resolve(jsonResponse(errorBody, 500)));

    const malformedError = await malformedClient.getMe().catch((error: unknown) => error);
    const apiError = await failedClient.getMe().catch((error: unknown) => error);

    expect(malformedError).toBeInstanceOf(ApiClientError);
    expect(malformedError).toMatchObject({
      kind: "invalid_response",
      status: 200,
    });
    expect(String(malformedError)).not.toContain("database-secret-detail");
    expect(apiError).toMatchObject({
      code: "INTERNAL_ERROR",
      kind: "api",
      requestId: REQUEST_ID,
      status: 500,
    });
    expect(String(apiError)).not.toContain("database-secret-detail");
  });

  it("normalizes network failures without retaining the raw exception", async () => {
    const client = createApiClient(() => Promise.reject(new Error("network-secret-detail")));

    const error = await client.getMe().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "network",
      status: 0,
    });
    expect(String(error)).not.toContain("network-secret-detail");
  });
});
