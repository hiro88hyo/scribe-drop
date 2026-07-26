import {
  ALLOWED_MEDIA_TYPES,
  MAX_FILE_SIZE_BYTES,
  artifactDownloadResponseSchema,
  cancelJobRequestSchema,
  createJobRequestSchema,
  createJobResponseSchema,
  jobActionResponseSchema,
  listJobsQuerySchema,
  listJobsResponseSchema,
  outputFormatSchema,
  retryJobRequestSchema,
  ulidSchema,
  uploadCompleteRequestSchema,
  type AllowedMediaType,
  type CreateJobResponse,
  type ArtifactDownloadResponse,
  type JobActionResponse,
  type ListJobsResponse,
  type TemporaryUploadCredentials,
} from "@scribe-drop/contracts";
import { z } from "zod";

import { createApiErrorResponse } from "../http/api-error.js";
import { getRequestId, getVerifiedAuthContext } from "../http/api-boundary.js";
import type { RandomBytes } from "../id/ulid.js";
import { createUlid } from "../id/ulid.js";
import type { WebRequestData } from "../web-context.js";
import { parseJobConfig, type JobEnvironment } from "./job-config.js";
import { decodeJobCursor } from "./job-cursor.js";
import {
  createD1JobRepository,
  findArtifactDownloadByOwner,
  requestJobCancellation,
  retryFailedJob,
  type JobDatabase,
  type JobRepository,
  type RequestJobCancellationInput,
  type RequestJobCancellationResult,
  type RetryFailedJobInput,
  type RetryFailedJobResult,
} from "./job-repository.js";
import { createOwnerHash, createSourceKey as createFinalSourceKey } from "./job-source-key.js";
import { createR2TemporaryUploadCredentials } from "./r2-temporary-credentials.js";
import { createArtifactDownload, type ArtifactDownloadInput } from "./r2-artifact-download.js";

const MAX_CREATE_JOB_BODY_BYTES = 16 * 1024;
const INVALID_REQUEST_MESSAGE = "入力内容を確認してください。";
const FILE_TOO_LARGE_MESSAGE = "ファイルサイズが上限を超えています。";
const UNSUPPORTED_MEDIA_TYPE_MESSAGE = "このメディア形式は利用できません。";
const TOO_MANY_ACTIVE_JOBS_MESSAGE = "処理中のジョブが上限に達しています。";
const RATE_LIMITED_MESSAGE = "ジョブ作成回数が上限に達しています。";
const NOT_FOUND_MESSAGE = "指定されたジョブは存在しません。";
const SOURCE_NOT_FOUND_MESSAGE = "アップロード済みファイルを確認できません。";
const SOURCE_SIZE_MISMATCH_MESSAGE = "アップロード済みファイルのサイズが一致しません。";
const SOURCE_ETAG_CHANGED_MESSAGE = "アップロード済みファイルが変更されています。";
const INVALID_STATE_MESSAGE = "現在の状態ではこの操作を実行できません。";
const ARTIFACT_NOT_READY_MESSAGE = "成果物はまだダウンロードできません。";

const r2HeadResultSchema = z.object({
  etag: z.string().min(1).max(512),
  size: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});

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

interface UploadCompleteHandlerContext {
  readonly data: WebRequestData;
  readonly env: JobsHandlerEnvironment & {
    readonly RECORDINGS: R2Bucket;
  };
  readonly params: {
    readonly id: string | string[];
  };
  readonly request: Request;
}

interface RetryJobHandlerContext {
  readonly data: WebRequestData;
  readonly env: JobEnvironment & {
    readonly SCRIBE_DROP_DB: D1Database;
  };
  readonly params: {
    readonly id: string | string[];
  };
  readonly request: Request;
}

interface ArtifactHandlerContext {
  readonly data: WebRequestData;
  readonly env: JobEnvironment & {
    readonly SCRIBE_DROP_DB: D1Database;
  };
  readonly params: {
    readonly format: string | string[];
    readonly id: string | string[];
  };
  readonly request: Request;
}

export interface JobHandlerDependencies {
  readonly createArtifactDownload?: (
    input: ArtifactDownloadInput,
  ) => Promise<ArtifactDownloadResponse>;
  readonly createAttemptId?: (timestampMilliseconds: number) => string;
  readonly createEventId?: (timestampMilliseconds: number) => string;
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
  readonly headSourceObject?: (bucket: R2Bucket, key: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly requestJobCancellation?: (
    database: D1Database,
    input: RequestJobCancellationInput,
  ) => Promise<RequestJobCancellationResult>;
  readonly retryFailedJob?: (
    database: D1Database,
    input: RetryFailedJobInput,
  ) => Promise<RetryFailedJobResult>;
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

export async function handleGetArtifact(
  context: ArtifactHandlerContext,
  dependencies: JobHandlerDependencies = {},
): Promise<Response> {
  const id = Array.isArray(context.params.id) ? undefined : context.params.id;
  const format = Array.isArray(context.params.format) ? undefined : context.params.format;
  const idResult = ulidSchema.safeParse(id);
  const formatResult = outputFormatSchema.safeParse(format);
  if (!idResult.success || !formatResult.success) {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }
  const config = parseJobConfig(context.env);
  if (config === undefined) {
    throw new Error("Job configuration is invalid");
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
  if (job.status !== "COMPLETED") {
    return createApiErrorResponse({
      code: "ARTIFACT_NOT_READY",
      message: ARTIFACT_NOT_READY_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }
  const artifact = await findArtifactDownloadByOwner(
    context.env.SCRIBE_DROP_DB,
    auth.sub,
    idResult.data,
    formatResult.data,
  );
  if (artifact === undefined) {
    return createApiErrorResponse({
      code: "ARTIFACT_NOT_READY",
      message: ARTIFACT_NOT_READY_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }
  const signArtifact = dependencies.createArtifactDownload ?? createArtifactDownload;
  const responseBody = artifactDownloadResponseSchema.parse(
    await signArtifact({
      accountId: config.cloudflareAccountId,
      bucket: config.r2BucketName,
      key: artifact.key,
      now: dependencies.now?.() ?? new Date(),
      parentAccessKeyId: config.r2ParentAccessKeyId,
      parentSecretAccessKey: config.r2ParentSecretAccessKey,
    }),
  ) satisfies ArtifactDownloadResponse;
  const response = Response.json(responseBody);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function handleRetryJob(
  context: RetryJobHandlerContext,
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

  const bodyResult = await readBoundedJsonBody(context.request);
  if (!bodyResult.ok || !retryJobRequestSchema.safeParse(bodyResult.value).success) {
    return invalidRequest(context.data);
  }
  const config = parseJobConfig(context.env);
  if (config === undefined) {
    throw new Error("Job configuration is invalid");
  }

  const auth = getVerifiedAuthContext(context.data);
  const now = dependencies.now?.() ?? new Date();
  const createAttemptId =
    dependencies.createAttemptId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes));
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes));
  const attemptId = createAttemptId(now.getTime());
  const ownerHash = await createOwnerHash(auth.sub, config.ownerHashHmacSecret);
  const resultPrefix = `results/${ownerHash}/${idResult.data}/${attemptId}/`;
  const retry = dependencies.retryFailedJob ?? retryFailedJob;
  const result = await retry(context.env.SCRIBE_DROP_DB, {
    attemptId,
    eventId: createEventId(now.getTime()),
    jobId: idResult.data,
    ownerSub: auth.sub,
    resultPrefix,
    timestamp: now.toISOString(),
  });
  if (result.status === "not_found") {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }
  if (result.status === "invalid_state") {
    return createApiErrorResponse({
      code: "INVALID_STATE",
      message: INVALID_STATE_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }

  const responseBody = jobActionResponseSchema.parse({
    job: result.job,
  }) satisfies JobActionResponse;
  return Response.json(responseBody);
}

export async function handleCancelJob(
  context: RetryJobHandlerContext,
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
  const bodyResult = await readBoundedJsonBody(context.request);
  if (!bodyResult.ok || !cancelJobRequestSchema.safeParse(bodyResult.value).success) {
    return invalidRequest(context.data);
  }

  const auth = getVerifiedAuthContext(context.data);
  const now = dependencies.now?.() ?? new Date();
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes));
  const requestCancellation = dependencies.requestJobCancellation ?? requestJobCancellation;
  const result = await requestCancellation(context.env.SCRIBE_DROP_DB, {
    eventId: createEventId(now.getTime()),
    jobId: idResult.data,
    ownerSub: auth.sub,
    timestamp: now.toISOString(),
  });
  if (result.status === "not_found") {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }
  if (result.status === "invalid_state") {
    return createApiErrorResponse({
      code: "INVALID_STATE",
      message: INVALID_STATE_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }

  const responseBody = jobActionResponseSchema.parse({
    job: result.job,
  }) satisfies JobActionResponse;
  return Response.json(responseBody);
}

export async function handleUploadComplete(
  context: UploadCompleteHandlerContext,
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

  const bodyResult = await readBoundedJsonBody(context.request);
  if (!bodyResult.ok || !uploadCompleteRequestSchema.safeParse(bodyResult.value).success) {
    return invalidRequest(context.data);
  }

  const config = parseJobConfig(context.env);
  if (config === undefined) {
    throw new Error("Job configuration is invalid");
  }

  const auth = getVerifiedAuthContext(context.data);
  const repositoryFactory = dependencies.createRepository ?? createD1JobRepository;
  const repository = repositoryFactory(context.env.SCRIBE_DROP_DB);
  const target = await repository.findUploadTargetByOwner(auth.sub, idResult.data);
  if (target === undefined) {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }
  if (target.sourceBucket !== config.r2BucketName) {
    throw new Error("Stored source bucket does not match the configured R2 binding");
  }

  const headSourceObject =
    dependencies.headSourceObject ?? ((bucket: R2Bucket, key: string) => bucket.head(key));
  const untrustedHead = await headSourceObject(context.env.RECORDINGS, target.sourceKey);
  if (untrustedHead === null) {
    return createApiErrorResponse({
      code: "SOURCE_NOT_FOUND",
      message: SOURCE_NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }
  const headResult = r2HeadResultSchema.safeParse(untrustedHead);
  if (!headResult.success) {
    throw new Error("R2 HEAD returned invalid metadata");
  }
  if (
    headResult.data.size !== target.expectedSizeBytes &&
    (target.sourceEtag === null || target.sourceEtag === headResult.data.etag)
  ) {
    return createApiErrorResponse({
      code: "SOURCE_SIZE_MISMATCH",
      message: SOURCE_SIZE_MISMATCH_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }

  const completedAt = dependencies.now?.() ?? new Date();
  const createEventId =
    dependencies.createEventId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes));
  const result = await repository.completeUpload({
    expectedVersion: target.version,
    eventId: createEventId(completedAt.getTime()),
    jobId: target.jobId,
    ownerSub: auth.sub,
    sizeBytes: headResult.data.size,
    sourceBucket: target.sourceBucket,
    sourceEtag: headResult.data.etag,
    sourceKey: target.sourceKey,
    timestamp: completedAt.toISOString(),
  });
  if (result.status === "not_found") {
    return createApiErrorResponse({
      code: "NOT_FOUND",
      message: NOT_FOUND_MESSAGE,
      requestId: getRequestId(context.data),
      status: 404,
    });
  }
  if (result.status === "source_mutated") {
    return createApiErrorResponse({
      code: "SOURCE_ETAG_CHANGED",
      message: SOURCE_ETAG_CHANGED_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }
  if (result.status === "invalid_state") {
    return createApiErrorResponse({
      code: "INVALID_STATE",
      message: INVALID_STATE_MESSAGE,
      requestId: getRequestId(context.data),
      status: 409,
    });
  }

  const responseBody = jobActionResponseSchema.parse({
    job: result.job,
  }) satisfies JobActionResponse;
  return Response.json(responseBody);
}
