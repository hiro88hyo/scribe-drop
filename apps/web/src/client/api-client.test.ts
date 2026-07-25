import {
  apiErrorResponseSchema,
  jobDetailSchema,
  listJobsResponseSchema,
  meResponseSchema,
  type JobDetail,
} from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import { ApiClientError, createApiClient, type ApiFetch } from "./api-client.js";

const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST_ID = "00000000-0000-4000-8000-000000000020";

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
