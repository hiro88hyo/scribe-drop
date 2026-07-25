import type { CompletedPart } from "@aws-sdk/client-s3";
import type { TemporaryUploadCredentials } from "@scribe-drop/contracts";

export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MULTIPART_QUEUE_SIZE = 3;
const MINIMUM_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_MULTIPART_PARTS = 10_000;
const SDK_MAX_ATTEMPTS = 4;

export type MultipartUploadErrorKind = "aborted" | "invalid_response" | "upload_failed";

export class MultipartUploadError extends Error {
  readonly kind: MultipartUploadErrorKind;

  constructor(kind: MultipartUploadErrorKind) {
    super(
      kind === "aborted" ? "アップロードをキャンセルしました。" : "アップロードに失敗しました。",
    );
    this.name = "MultipartUploadError";
    this.kind = kind;
  }
}

export interface MultipartUploadProgress {
  readonly bytesPerSecond: number;
  readonly etaSeconds: number | null;
  readonly percent: number;
  readonly totalBytes: number;
  readonly uploadedBytes: number;
}

export interface MultipartUploadResult {
  readonly eTag: string;
  readonly partCount: number;
}

interface CreateMultipartInput {
  readonly contentType: string;
  readonly signal: AbortSignal;
}

interface UploadPartInput {
  readonly body: Blob;
  readonly contentLength: number;
  readonly partNumber: number;
  readonly signal: AbortSignal;
  readonly uploadId: string;
}

interface CompleteMultipartInput {
  readonly parts: readonly CompletedPart[];
  readonly signal: AbortSignal;
  readonly uploadId: string;
}

export interface MultipartTransport {
  abort(uploadId: string): Promise<void>;
  complete(input: CompleteMultipartInput): Promise<{ readonly eTag: string }>;
  create(input: CreateMultipartInput): Promise<{ readonly uploadId: string }>;
  destroy(): void;
  uploadPart(input: UploadPartInput): Promise<{ readonly eTag: string }>;
}

export interface MultipartUploadInput {
  readonly concurrency?: number;
  readonly credentials: TemporaryUploadCredentials;
  readonly file: File;
  readonly nowMilliseconds?: () => number;
  readonly onProgress?: (progress: MultipartUploadProgress) => void;
  readonly partSizeBytes?: number;
  readonly signal: AbortSignal;
  readonly transport?: MultipartTransport;
}

function requireNonEmpty(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.length > 4096) {
    throw new MultipartUploadError("invalid_response");
  }
  return value;
}

async function createAwsMultipartTransport(
  credentials: TemporaryUploadCredentials,
): Promise<MultipartTransport> {
  const {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    S3Client,
    UploadPartCommand,
  } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    endpoint: credentials.endpoint,
    forcePathStyle: true,
    maxAttempts: SDK_MAX_ATTEMPTS,
    region: credentials.region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const target = {
    Bucket: credentials.bucket,
    Key: credentials.key,
  } as const;

  return {
    async abort(uploadId) {
      await client.send(
        new AbortMultipartUploadCommand({
          ...target,
          UploadId: uploadId,
        }),
      );
    },

    async complete(input) {
      const output = await client.send(
        new CompleteMultipartUploadCommand({
          ...target,
          MultipartUpload: {
            Parts: [...input.parts],
          },
          UploadId: input.uploadId,
        }),
        { abortSignal: input.signal },
      );
      return { eTag: requireNonEmpty(output.ETag) };
    },

    async create(input) {
      const output = await client.send(
        new CreateMultipartUploadCommand({
          ...target,
          ContentType: input.contentType,
        }),
        { abortSignal: input.signal },
      );
      return { uploadId: requireNonEmpty(output.UploadId) };
    },

    destroy() {
      client.destroy();
    },

    async uploadPart(input) {
      const output = await client.send(
        new UploadPartCommand({
          ...target,
          Body: input.body,
          ContentLength: input.contentLength,
          PartNumber: input.partNumber,
          UploadId: input.uploadId,
        }),
        { abortSignal: input.signal },
      );
      return { eTag: requireNonEmpty(output.ETag) };
    },
  };
}

function normalizeUploadError(error: unknown, signal: AbortSignal): MultipartUploadError {
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof MultipartUploadError && error.kind === "aborted")
  ) {
    return new MultipartUploadError("aborted");
  }
  if (error instanceof MultipartUploadError) {
    return error;
  }
  return new MultipartUploadError("upload_failed");
}

function validateUploadShape(file: File, partSizeBytes: number, concurrency: number): number {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    !Number.isSafeInteger(partSizeBytes) ||
    partSizeBytes < MINIMUM_MULTIPART_PART_SIZE_BYTES ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  ) {
    throw new MultipartUploadError("invalid_response");
  }
  const partCount = Math.ceil(file.size / partSizeBytes);
  if (partCount < 1 || partCount > MAXIMUM_MULTIPART_PARTS) {
    throw new MultipartUploadError("invalid_response");
  }
  return partCount;
}

function emitProgress(
  callback: MultipartUploadInput["onProgress"],
  uploadedBytes: number,
  totalBytes: number,
  startedAtMilliseconds: number,
  nowMilliseconds: () => number,
): void {
  if (callback === undefined) {
    return;
  }
  const elapsedSeconds = Math.max(0.001, (nowMilliseconds() - startedAtMilliseconds) / 1000);
  const bytesPerSecond = uploadedBytes / elapsedSeconds;
  callback({
    bytesPerSecond,
    etaSeconds:
      uploadedBytes === 0 || bytesPerSecond === 0
        ? null
        : Math.max(0, (totalBytes - uploadedBytes) / bytesPerSecond),
    percent: Math.min(100, (uploadedBytes / totalBytes) * 100),
    totalBytes,
    uploadedBytes,
  });
}

export async function uploadFileMultipart(
  input: MultipartUploadInput,
): Promise<MultipartUploadResult> {
  const partSizeBytes = input.partSizeBytes ?? MULTIPART_PART_SIZE_BYTES;
  const concurrency = input.concurrency ?? MULTIPART_QUEUE_SIZE;
  const partCount = validateUploadShape(input.file, partSizeBytes, concurrency);
  const nowMilliseconds = input.nowMilliseconds ?? (() => performance.now());
  const startedAtMilliseconds = nowMilliseconds();
  const transport = input.transport ?? (await createAwsMultipartTransport(input.credentials));
  const operationController = new AbortController();
  const abortOperation = (): void => {
    operationController.abort();
  };
  input.signal.addEventListener("abort", abortOperation, { once: true });

  let uploadId: string | undefined;
  try {
    if (input.signal.aborted) {
      throw new MultipartUploadError("aborted");
    }
    emitProgress(input.onProgress, 0, input.file.size, startedAtMilliseconds, nowMilliseconds);
    uploadId = (
      await transport.create({
        contentType: input.file.type,
        signal: operationController.signal,
      })
    ).uploadId;
    const activeUploadId = uploadId;

    const parts: (CompletedPart | undefined)[] = Array.from({ length: partCount }, () => undefined);
    let nextPartIndex = 0;
    let uploadedBytes = 0;
    let firstFailure: unknown;

    const uploadNextPart = async (): Promise<void> => {
      while (!operationController.signal.aborted) {
        const partIndex = nextPartIndex;
        nextPartIndex += 1;
        if (partIndex >= partCount) {
          return;
        }

        const start = partIndex * partSizeBytes;
        const end = Math.min(start + partSizeBytes, input.file.size);
        try {
          const result = await transport.uploadPart({
            body: input.file.slice(start, end, input.file.type),
            contentLength: end - start,
            partNumber: partIndex + 1,
            signal: operationController.signal,
            uploadId: activeUploadId,
          });
          parts[partIndex] = {
            ETag: result.eTag,
            PartNumber: partIndex + 1,
          };
          uploadedBytes += end - start;
          emitProgress(
            input.onProgress,
            uploadedBytes,
            input.file.size,
            startedAtMilliseconds,
            nowMilliseconds,
          );
        } catch (error) {
          firstFailure ??= error;
          operationController.abort();
          return;
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, partCount) }, () =>
      uploadNextPart(),
    );
    await Promise.all(workers);
    if (firstFailure !== undefined) {
      throw normalizeUploadError(firstFailure, input.signal);
    }
    if (operationController.signal.aborted) {
      throw new MultipartUploadError("aborted");
    }
    const completedParts = parts.map((part) => {
      if (part === undefined) {
        throw new MultipartUploadError("invalid_response");
      }
      return part;
    });

    const result = await transport.complete({
      parts: completedParts,
      signal: operationController.signal,
      uploadId: activeUploadId,
    });
    return {
      eTag: result.eTag,
      partCount,
    };
  } catch (error) {
    operationController.abort();
    if (uploadId !== undefined) {
      try {
        await transport.abort(uploadId);
      } catch {
        // R2 automatically removes incomplete multipart uploads after its configured lifecycle.
      }
    }
    throw normalizeUploadError(error, input.signal);
  } finally {
    input.signal.removeEventListener("abort", abortOperation);
    transport.destroy();
  }
}
