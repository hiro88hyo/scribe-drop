import type { TemporaryUploadCredentials } from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import {
  MultipartUploadError,
  uploadFileMultipart,
  type MultipartTransport,
  type MultipartUploadProgress,
} from "./multipart-uploader.js";

const CREDENTIALS = {
  accessKeyId: "temporary-access-key",
  bucket: "recording-transcriber-test",
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  expiresAt: "2027-01-01T00:15:00.000Z",
  key: "incoming/owner/job/nonce/source.m4a",
  region: "auto",
  secretAccessKey: "temporary-secret-key",
  sessionToken: "temporary-session-token",
} satisfies TemporaryUploadCredentials;
const TEST_PART_SIZE_BYTES = 5 * 1024 * 1024;

interface FakeTransportObservations {
  aborts: string[];
  completedPartNumbers: number[];
  createContentTypes: string[];
  creates: number;
  destroyed: number;
  maximumActiveParts: number;
  uploadedBodyTypes: string[];
  uploadedPartNumbers: number[];
}

function createFakeTransport(options?: { readonly failPartNumber?: number }): {
  readonly observations: FakeTransportObservations;
  readonly transport: MultipartTransport;
} {
  const observations: FakeTransportObservations = {
    aborts: [],
    completedPartNumbers: [],
    createContentTypes: [],
    creates: 0,
    destroyed: 0,
    maximumActiveParts: 0,
    uploadedBodyTypes: [],
    uploadedPartNumbers: [],
  };
  let activeParts = 0;

  return {
    observations,
    transport: {
      abort(uploadId) {
        observations.aborts.push(uploadId);
        return Promise.resolve();
      },
      complete(input) {
        observations.completedPartNumbers.push(...input.parts.map((part) => part.PartNumber ?? -1));
        return Promise.resolve({ eTag: '"complete-etag-3"' });
      },
      create(input) {
        observations.createContentTypes.push(input.contentType);
        observations.creates += 1;
        return Promise.resolve({ uploadId: "upload-id" });
      },
      destroy() {
        observations.destroyed += 1;
      },
      async uploadPart(input) {
        observations.uploadedBodyTypes.push(input.body.type);
        observations.uploadedPartNumbers.push(input.partNumber);
        activeParts += 1;
        observations.maximumActiveParts = Math.max(observations.maximumActiveParts, activeParts);
        await Promise.resolve();
        activeParts -= 1;
        if (input.partNumber === options?.failPartNumber) {
          throw new Error("raw-network-secret-detail");
        }
        return { eTag: `"part-${String(input.partNumber)}"` };
      },
    },
  };
}

function createFile(sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], "recording.m4a", {
    type: "audio/mp4",
  });
}

describe("browser multipart uploader", () => {
  it("uses multipart even for a one-part file", async () => {
    const { observations, transport } = createFakeTransport();

    const result = await uploadFileMultipart({
      contentType: "audio/mp4",
      credentials: CREDENTIALS,
      file: createFile(1024),
      signal: new AbortController().signal,
      transport,
    });

    expect(result).toEqual({
      eTag: '"complete-etag-3"',
      partCount: 1,
    });
    expect(observations).toMatchObject({
      aborts: [],
      completedPartNumbers: [1],
      creates: 1,
      destroyed: 1,
      uploadedPartNumbers: [1],
    });
  });

  it("limits parallel parts and reports completed-byte progress, speed, and ETA", async () => {
    const { observations, transport } = createFakeTransport();
    const progress: MultipartUploadProgress[] = [];
    let now = 0;

    await uploadFileMultipart({
      concurrency: 3,
      contentType: "audio/mp4",
      credentials: CREDENTIALS,
      file: createFile(TEST_PART_SIZE_BYTES * 3 + 1),
      nowMilliseconds: () => {
        now += 1000;
        return now;
      },
      onProgress: (update) => {
        progress.push(update);
      },
      partSizeBytes: TEST_PART_SIZE_BYTES,
      signal: new AbortController().signal,
      transport,
    });

    expect(observations.maximumActiveParts).toBe(3);
    expect(observations.completedPartNumbers).toEqual([1, 2, 3, 4]);
    expect(progress[0]).toMatchObject({
      etaSeconds: null,
      percent: 0,
      uploadedBytes: 0,
    });
    expect(progress.at(-1)).toMatchObject({
      etaSeconds: 0,
      percent: 100,
      totalBytes: TEST_PART_SIZE_BYTES * 3 + 1,
      uploadedBytes: TEST_PART_SIZE_BYTES * 3 + 1,
    });
    expect(progress.at(-1)?.bytesPerSecond).toBeGreaterThan(0);
  });

  it("aborts an incomplete multipart upload and hides the raw failure", async () => {
    const { observations, transport } = createFakeTransport({ failPartNumber: 2 });

    const error = await uploadFileMultipart({
      contentType: "audio/mp4",
      credentials: CREDENTIALS,
      file: createFile(TEST_PART_SIZE_BYTES * 3 + 1),
      partSizeBytes: TEST_PART_SIZE_BYTES,
      signal: new AbortController().signal,
      transport,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MultipartUploadError);
    expect(error).toMatchObject({ kind: "upload_failed" });
    expect(String(error)).not.toContain("raw-network-secret-detail");
    expect(observations.aborts).toEqual(["upload-id"]);
    expect(observations.completedPartNumbers).toEqual([]);
    expect(observations.destroyed).toBe(1);
  });

  it("cancels in-flight work and requests multipart cleanup", async () => {
    const controller = new AbortController();
    const observations = {
      aborts: 0,
      destroyed: 0,
    };
    const transport: MultipartTransport = {
      abort() {
        observations.aborts += 1;
        return Promise.resolve();
      },
      complete() {
        return Promise.resolve({ eTag: '"unexpected"' });
      },
      create() {
        return Promise.resolve({ uploadId: "upload-id" });
      },
      destroy() {
        observations.destroyed += 1;
      },
      uploadPart(input) {
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("test abort detail", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };

    const upload = uploadFileMultipart({
      contentType: "audio/mp4",
      credentials: CREDENTIALS,
      file: createFile(1024),
      signal: controller.signal,
      transport,
    });
    await Promise.resolve();
    controller.abort();

    await expect(upload).rejects.toMatchObject({ kind: "aborted" });
    expect(observations).toEqual({
      aborts: 1,
      destroyed: 1,
    });
  });

  it("uses the canonical request MIME type instead of an Android file alias", async () => {
    const { observations, transport } = createFakeTransport();
    const file = new File([new Uint8Array(1024)], "recording.m4a", {
      type: "audio/mp4a-latm",
    });

    await uploadFileMultipart({
      contentType: "audio/mp4",
      credentials: CREDENTIALS,
      file,
      signal: new AbortController().signal,
      transport,
    });

    expect(observations.createContentTypes).toEqual(["audio/mp4"]);
    expect(observations.uploadedBodyTypes).toEqual(["audio/mp4"]);
  });
});
