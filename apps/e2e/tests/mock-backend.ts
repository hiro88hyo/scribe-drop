import type { BrowserContext, Page, Route } from "@playwright/test";

export const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PRIVATE_MARKER = "PRIVATE_E2E_JOB_MARKER";

const CSRF_TOKEN = "dummy-csrf-token-value-000000000000";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T00:01:00.000Z";
const STORAGE_ORIGIN = "https://storage.example.invalid";
const DOWNLOAD_ORIGIN = `https://${"0".repeat(32)}.r2.cloudflarestorage.com`;
const ARTIFACT_FIXTURES = {
  json: {
    body: '{"schemaVersion":1,"segments":[]}\n',
    contentType: "application/json",
    filename: "transcript.json",
  },
  markdown: {
    body: "# Dummy E2E artifact\n",
    contentType: "text/markdown; charset=utf-8",
    filename: "transcript.md",
  },
  srt: {
    body: "1\n00:00:00,000 --> 00:00:01,000\nDummy\n",
    contentType: "application/x-subrip; charset=utf-8",
    filename: "transcript.srt",
  },
} as const;

type JobStatus = "COMPLETED" | "FAILED" | "RUNNING" | "SUBMISSION_PENDING" | "UPLOADED";

interface JobSummaryFixture {
  readonly actualSizeBytes: number;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly durationSeconds: number | null;
  readonly errorCode: "PROCESSING_FAILED" | null;
  readonly expectedSizeBytes: number;
  readonly id: string;
  readonly originalFilename: string;
  readonly sourceContentType: "audio/mpeg";
  readonly status: JobStatus;
  readonly title: string;
  readonly updatedAt: string;
}

interface JobDetailFixture extends JobSummaryFixture {
  readonly artifacts: readonly {
    readonly format: "json" | "markdown" | "srt";
    readonly sizeBytes: number;
  }[];
  readonly options: {
    readonly language: "ja";
    readonly model: "large-v3-turbo";
    readonly outputFormats: readonly ["markdown", "srt", "json"];
    readonly vad: true;
  };
}

export interface MockBackendState {
  created: boolean;
  createAttempts: number;
  deleted: boolean;
  detailRequests: number;
  multipartCompleted: boolean;
  mutationHeadersValid: boolean;
  uploadPartObserved: boolean;
}

interface MockBackendOptions {
  readonly detailStatuses?: readonly JobStatus[];
  readonly failDetailRequestAt?: number;
  readonly failFirstCreate?: boolean;
  readonly listPrivateMarker?: boolean;
  readonly persistCreatedJobInList?: boolean;
  readonly uploadPartDelayMilliseconds?: number;
}

type RouteTarget = BrowserContext | Page;

function summary(status: JobStatus, title = "E2E meeting"): JobSummaryFixture {
  const completed = status === "COMPLETED";
  const failed = status === "FAILED";
  return {
    actualSizeBytes: 11,
    completedAt: completed ? UPDATED_AT : null,
    createdAt: CREATED_AT,
    durationSeconds: completed ? 12 : null,
    errorCode: failed ? "PROCESSING_FAILED" : null,
    expectedSizeBytes: 11,
    id: JOB_ID,
    originalFilename: "meeting.mp3",
    sourceContentType: "audio/mpeg",
    status,
    title,
    updatedAt: UPDATED_AT,
  };
}

function detail(status: JobStatus): JobDetailFixture {
  return {
    ...summary(status),
    artifacts:
      status === "COMPLETED"
        ? [
            {
              format: "markdown",
              sizeBytes: Buffer.byteLength(ARTIFACT_FIXTURES.markdown.body),
            },
            { format: "srt", sizeBytes: Buffer.byteLength(ARTIFACT_FIXTURES.srt.body) },
            { format: "json", sizeBytes: Buffer.byteLength(ARTIFACT_FIXTURES.json.body) },
          ]
        : [],
    options: {
      language: "ja",
      model: "large-v3-turbo",
      outputFormats: ["markdown", "srt", "json"],
      vad: true,
    },
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: {
      "Cache-Control": "no-store",
    },
    status,
  });
}

function hasValidMutationHeaders(route: Route): boolean {
  const headers = route.request().headers();
  return (
    headers["content-type"]?.startsWith("application/json") === true &&
    headers["x-csrf-token"] === CSRF_TOKEN
  );
}

async function installStorageMock(
  target: RouteTarget,
  state: MockBackendState,
  uploadPartDelayMilliseconds: number,
): Promise<void> {
  await target.route(`${STORAGE_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const corsHeaders = {
      "Access-Control-Allow-Headers":
        request.headers()["access-control-request-headers"] ??
        "authorization,content-type,x-amz-content-sha256,x-amz-date,x-amz-security-token",
      "Access-Control-Allow-Methods": "DELETE,POST,PUT",
      "Access-Control-Allow-Origin": request.headers()["origin"] ?? "http://127.0.0.1:4173",
      "Access-Control-Expose-Headers": "ETag,x-amz-request-id",
    };

    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }
    if (request.method() === "POST" && url.searchParams.has("uploads")) {
      await route.fulfill({
        body:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          "<Bucket>dummy-bucket</Bucket><Key>incoming/dummy/source.mp3</Key>" +
          "<UploadId>dummy-upload-id</UploadId></InitiateMultipartUploadResult>",
        contentType: "application/xml",
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (request.method() === "PUT" && url.searchParams.has("partNumber")) {
      state.uploadPartObserved = true;
      await new Promise((resolve) => {
        setTimeout(resolve, uploadPartDelayMilliseconds);
      });
      await route.fulfill({
        body: "",
        headers: {
          ...corsHeaders,
          ETag: '"dummy-part-etag"',
        },
        status: 200,
      });
      return;
    }
    if (request.method() === "POST" && url.searchParams.has("uploadId")) {
      state.multipartCompleted = true;
      await route.fulfill({
        body:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          `<Location>${STORAGE_ORIGIN}/dummy-bucket/incoming/dummy/source.mp3</Location>` +
          "<Bucket>dummy-bucket</Bucket><Key>incoming/dummy/source.mp3</Key>" +
          '<ETag>"dummy-complete-etag"</ETag></CompleteMultipartUploadResult>',
        contentType: "application/xml",
        headers: corsHeaders,
        status: 200,
      });
      return;
    }
    if (request.method() === "DELETE") {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }
    await route.abort("failed");
  });

  await target.route(`${DOWNLOAD_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const filename = new URL(request.url()).pathname.split("/").at(-1);
    const fixture = Object.values(ARTIFACT_FIXTURES).find(
      (candidate) => candidate.filename === filename,
    );
    if (fixture === undefined) {
      await route.abort("failed");
      return;
    }
    const origin = request.headers()["origin"] ?? "http://127.0.0.1:4173";
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        headers: {
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Origin": origin,
        },
        status: 204,
      });
      return;
    }
    await route.fulfill({
      body: fixture.body,
      contentType: fixture.contentType,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fixture.filename}"`,
        "Content-Length": String(Buffer.byteLength(fixture.body)),
      },
      status: 200,
    });
  });
}

export async function installMockBackend(
  target: RouteTarget,
  options: MockBackendOptions = {},
): Promise<MockBackendState> {
  const detailStatuses = options.detailStatuses ?? ["SUBMISSION_PENDING", "RUNNING", "COMPLETED"];
  const state: MockBackendState = {
    created: false,
    createAttempts: 0,
    deleted: false,
    detailRequests: 0,
    multipartCompleted: false,
    mutationHeadersValid: true,
    uploadPartObserved: false,
  };
  let successfulDetailResponses = 0;

  await installStorageMock(target, state, options.uploadPartDelayMilliseconds ?? 250);
  await target.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/me") {
      await json(route, {
        csrfToken: CSRF_TOKEN,
        user: {
          email: "e2e-user@example.com",
          sub: "dummy-e2e-user",
        },
      });
      return;
    }

    if (request.method() === "GET" && path === "/api/jobs") {
      const visibleJob =
        !state.deleted &&
        (options.listPrivateMarker === true ||
          (options.persistCreatedJobInList === true && state.created));
      await json(route, {
        items: visibleJob
          ? [
              summary(
                options.listPrivateMarker === true ? "COMPLETED" : "SUBMISSION_PENDING",
                options.listPrivateMarker === true ? PRIVATE_MARKER : "E2E meeting",
              ),
            ]
          : [],
        nextCursor: null,
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/jobs") {
      state.createAttempts += 1;
      state.mutationHeadersValid &&= hasValidMutationHeaders(route);
      if (options.failFirstCreate === true && state.createAttempts === 1) {
        await json(
          route,
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Dummy upstream failure",
              requestId: "dummy-e2e-request",
            },
          },
          503,
        );
        return;
      }
      state.created = true;
      await json(route, {
        jobId: JOB_ID,
        upload: {
          accessKeyId: "dummy-access-key",
          bucket: "dummy-bucket",
          endpoint: STORAGE_ORIGIN,
          expiresAt: "2030-01-01T00:00:00.000Z",
          key: "incoming/dummy/source.mp3",
          region: "auto",
          secretAccessKey: "dummy-secret-access-key",
          sessionToken: "dummy-session-token",
        },
      });
      return;
    }

    if (request.method() === "POST" && path === `/api/jobs/${JOB_ID}/upload-complete`) {
      state.mutationHeadersValid &&= hasValidMutationHeaders(route);
      await json(route, { job: summary("UPLOADED") });
      return;
    }

    if (request.method() === "GET" && path === `/api/jobs/${JOB_ID}`) {
      state.detailRequests += 1;
      if (state.detailRequests === options.failDetailRequestAt) {
        await route.abort("failed");
        return;
      }
      const index = Math.min(successfulDetailResponses, detailStatuses.length - 1);
      const status = detailStatuses[index] ?? "COMPLETED";
      successfulDetailResponses += 1;
      await json(route, detail(status));
      return;
    }

    const artifactMatch = new RegExp(
      `^/api/jobs/${JOB_ID}/artifacts/(markdown|json|srt)$`,
      "u",
    ).exec(path);
    if (request.method() === "GET" && artifactMatch !== null) {
      const format = artifactMatch[1];
      if (format !== "markdown" && format !== "json" && format !== "srt") {
        await route.abort("failed");
        return;
      }
      await json(route, {
        expiresAt: "2030-01-01T00:00:00.000Z",
        url: `${DOWNLOAD_ORIGIN}/dummy/results/${ARTIFACT_FIXTURES[format].filename}`,
      });
      return;
    }

    if (request.method() === "DELETE" && path === `/api/jobs/${JOB_ID}`) {
      state.mutationHeadersValid &&= hasValidMutationHeaders(route);
      state.deleted = true;
      await json(route, { deleted: true }, 202);
      return;
    }

    await json(
      route,
      {
        error: {
          code: "NOT_FOUND",
          message: "Dummy route not found",
          requestId: "dummy-e2e-route",
        },
      },
      404,
    );
  });

  return state;
}
