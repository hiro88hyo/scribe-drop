import {
  ALLOWED_MEDIA_TYPES,
  MAX_FILE_SIZE_BYTES,
  createJobRequestSchema,
  createJobResponseSchema,
  listJobsQuerySchema,
  listJobsResponseSchema,
  ulidSchema,
  type AllowedMediaType,
  type CreateJobResponse,
  type ListJobsResponse,
  type TemporaryUploadCredentials,
} from "@scribe-drop/contracts";

import { createApiErrorResponse } from "../http/api-error.js";
import { getRequestId, getVerifiedAuthContext } from "../http/api-boundary.js";
import type { RandomBytes } from "../id/ulid.js";
import { createUlid } from "../id/ulid.js";
import type { WebRequestData } from "../web-context.js";
import { parseJobConfig, type JobEnvironment } from "./job-config.js";
import { decodeJobCursor } from "./job-cursor.js";
import { createD1JobRepository, type JobDatabase, type JobRepository } from "./job-repository.js";
import { createSourceKey as createFinalSourceKey } from "./job-source-key.js";
import { createR2TemporaryUploadCredentials } from "./r2-temporary-credentials.js";

const MAX_CREATE_JOB_BODY_BYTES = 16 * 1024;
const INVALID_REQUEST_MESSAGE = "入力内容を確認してください。";
const FILE_TOO_LARGE_MESSAGE = "ファイルサイズが上限を超えています。";
const UNSUPPORTED_MEDIA_TYPE_MESSAGE = "このメディア形式は利用できません。";
const TOO_MANY_ACTIVE_JOBS_MESSAGE = "処理中のジョブが上限に達しています。";
const RATE_LIMITED_MESSAGE = "ジョブ作成回数が上限に達しています。";
const NOT_FOUND_MESSAGE = "指定されたジョブは存在しません。";

interface JobsHandlerEnvironment extends JobEnvironment {
  readonly SCRIBE_DROP_DB: JobDatabase;
}

interface JobsHandlerContext {
  readonly data: WebRequestData;
  readonly env: JobsHandlerEnvironment;
  readonly request: Request;
}

interface JobDetailHandlerContext extends JobsHandlerContext {
  readonly params: {
    readonly id: string | string[];
  };
}

export interface JobHandlerDependencies {
  readonly createJobId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: JobDatabase) => JobRepository;
  readonly createSourceKey?: (
    ownerSub: string,
    ownerHashHmacSecret: string,
    jobId: string,
    contentType: AllowedMediaType,
  ) => Promise<string> | string;
  readonly createTemporaryUploadCredentials?: (input: {
    readonly accountId: string;
    readonly bucket: string;
    readonly key: string;
    readonly now: Date;
    readonly parentAccessKeyId: string;
    readonly parentSecretAccessKey: string;
  }) => Promise<TemporaryUploadCredentials>;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
}

type JsonBodyResult =
  | {
      readonly ok: false;
    }
  | {
      readonly ok: true;
      readonly value: unknown;
    };

async function readBoundedJsonBody(request: Request): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_CREATE_JOB_BODY_BYTES) {
      return { ok: false };
    }
  }

  const text = await request.text();
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_CREATE_JOB_BODY_BYTES) {
    return { ok: false };
  }

  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyCreateRequestError(
  untrusted: unknown,
): "file_too_large" | "invalid" | "unsupported_media_type" {
  if (!isRecord(untrusted)) {
    return "invalid";
  }
  if (typeof untrusted["sizeBytes"] === "number" && untrusted["sizeBytes"] > MAX_FILE_SIZE_BYTES) {
    return "file_too_large";
  }
  if (
    typeof untrusted["contentType"] === "string" &&
    !ALLOWED_MEDIA_TYPES.some((mediaType) => mediaType === untrusted["contentType"])
  ) {
    return "unsupported_media_type";
  }
  return "invalid";
}

function parseListQuery(url: URL):
  | {
      readonly cursor?: string;
      readonly limit: number;
      readonly ok: true;
    }
  | {
      readonly ok: false;
    } {
  const allowedKeys = new Set(["cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      return { ok: false };
    }
  }

  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null || rawLimit.length === 0 ? undefined : Number(rawLimit);
  const result = listJobsQuerySchema.safeParse({
    ...(cursor === null ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
  return result.success
    ? {
        ...(result.data.cursor === undefined ? {} : { cursor: result.data.cursor }),
        limit: result.data.limit,
        ok: true,
      }
    : { ok: false };
}

function invalidRequest(data: WebRequestData): Response {
  return createApiErrorResponse({
    code: "INVALID_REQUEST",
    message: INVALID_REQUEST_MESSAGE,
    requestId: getRequestId(data),
    status: 400,
  });
}

export async function handleCreateJob(
  context: JobsHandlerContext,
  dependencies: JobHandlerDependencies = {},
): Promise<Response> {
  const bodyResult = await readBoundedJsonBody(context.request);
  if (!bodyResult.ok) {
    return invalidRequest(context.data);
  }

  const requestResult = createJobRequestSchema.safeParse(bodyResult.value);
  if (!requestResult.success) {
    const classification = classifyCreateRequestError(bodyResult.value);
    if (classification === "file_too_large") {
      return createApiErrorResponse({
        code: "FILE_TOO_LARGE",
        message: FILE_TOO_LARGE_MESSAGE,
        requestId: getRequestId(context.data),
        status: 413,
      });
    }
    if (classification === "unsupported_media_type") {
      return createApiErrorResponse({
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: UNSUPPORTED_MEDIA_TYPE_MESSAGE,
        requestId: getRequestId(context.data),
        status: 415,
      });
    }
    return invalidRequest(context.data);
  }

  const config = parseJobConfig(context.env);
  if (config === undefined) {
    throw new Error("Job configuration is invalid");
  }

  const auth = getVerifiedAuthContext(context.data);
  const now = dependencies.now?.() ?? new Date();
  const createJobId =
    dependencies.createJobId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes));
  const jobId = createJobId(now.getTime());
  const createJobSourceKey =
    dependencies.createSourceKey ??
    ((ownerSub: string, ownerHashHmacSecret: string, id: string, contentType: AllowedMediaType) =>
      createFinalSourceKey(
        ownerSub,
        ownerHashHmacSecret,
        id,
        contentType,
        dependencies.randomBytes,
      ));
  const sourceKey = await createJobSourceKey(
    auth.sub,
    config.ownerHashHmacSecret,
    jobId,
    requestResult.data.contentType,
  );
  const repositoryFactory = dependencies.createRepository ?? createD1JobRepository;
  const repository = repositoryFactory(context.env.SCRIBE_DROP_DB);
  const result = await repository.create({
    expectedSizeBytes: requestResult.data.sizeBytes,
    id: jobId,
    options: requestResult.data.options,
    originalFilename: requestResult.data.filename,
    ownerEmail: auth.email,
    ownerSub: auth.sub,
    sourceBucket: config.r2BucketName,
    sourceContentType: requestResult.data.contentType,
    sourceKey,
    timestamp: now.toISOString(),
    title: requestResult.data.title,
  });

  if (result.status === "too_many_active_jobs") {
    return createApiErrorResponse({
      code: "TOO_MANY_ACTIVE_JOBS",
      message: TOO_MANY_ACTIVE_JOBS_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }
  if (result.status === "rate_limited") {
    const response = createApiErrorResponse({
      code: "RATE_LIMITED",
      message: RATE_LIMITED_MESSAGE,
      requestId: getRequestId(context.data),
      status: 429,
    });
    response.headers.set("Retry-After", String(result.retryAfterSeconds));
    return response;
  }

  const createTemporaryUploadCredentials =
    dependencies.createTemporaryUploadCredentials ?? createR2TemporaryUploadCredentials;
  let responseBody: CreateJobResponse;
  try {
    const upload = await createTemporaryUploadCredentials({
      accountId: config.cloudflareAccountId,
      bucket: config.r2BucketName,
      key: sourceKey,
      now,
      parentAccessKeyId: config.r2ParentAccessKeyId,
      parentSecretAccessKey: config.r2ParentSecretAccessKey,
    });
    responseBody = createJobResponseSchema.parse({
      jobId,
      upload,
    }) satisfies CreateJobResponse;

    const markedReady = await repository.markUploadReady({
      jobId,
      ownerSub: auth.sub,
      timestamp: now.toISOString(),
      uploadExpiresAt: upload.expiresAt,
    });
    if (!markedReady) {
      throw new Error("Created job could not transition to uploading");
    }
  } catch {
    await repository.failUploadPreparation({
      jobId,
      ownerSub: auth.sub,
      timestamp: now.toISOString(),
    });
    throw new Error("Upload preparation failed");
  }

  return Response.json(responseBody, { status: 201 });
}

export async function handleListJobs(
  context: JobsHandlerContext,
  dependencies: JobHandlerDependencies = {},
): Promise<Response> {
  const query = parseListQuery(new URL(context.request.url));
  if (!query.ok) {
    return invalidRequest(context.data);
  }
  const cursor = query.cursor === undefined ? undefined : decodeJobCursor(query.cursor);
  if (query.cursor !== undefined && cursor === undefined) {
    return invalidRequest(context.data);
  }

  const auth = getVerifiedAuthContext(context.data);
  const repositoryFactory = dependencies.createRepository ?? createD1JobRepository;
  const responseBody = await repositoryFactory(context.env.SCRIBE_DROP_DB).listByOwner({
    ...(cursor === undefined ? {} : { cursor }),
    limit: query.limit,
    ownerSub: auth.sub,
  });

  return Response.json(listJobsResponseSchema.parse(responseBody) satisfies ListJobsResponse);
}

export async function handleGetJob(
  context: JobDetailHandlerContext,
  dependencies: JobHandlerDependencies = {},
): Promise<Response> {
  const id = Array.isArray(context.params.id) ? undefined : context.params.id;
  const idResult = ulidSchema.safeParse(id);
  if (!idResult.success) {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }

  const auth = getVerifiedAuthContext(context.data);
  const repositoryFactory = dependencies.createRepository ?? createD1JobRepository;
  const job = await repositoryFactory(context.env.SCRIBE_DROP_DB).findByOwner(
    auth.sub,
    idResult.data,
  );
  if (job === undefined) {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }

  return Response.json(job);
}
