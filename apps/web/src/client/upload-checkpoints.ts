import {
  MAX_FILE_SIZE_BYTES,
  MAX_ORIGINAL_FILENAME_LENGTH,
  allowedMediaTypeSchema,
  ulidSchema,
  utcDateTimeSchema,
} from "@scribe-drop/contracts";
import { z } from "zod";

const DATABASE_NAME = "scribe-drop";
const DATABASE_VERSION = 1;
const STORE_NAME = "upload-checkpoints";

export const uploadCheckpointSchema = z
  .object({
    contentType: allowedMediaTypeSchema,
    filename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_LENGTH),
    jobId: ulidSchema,
    sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
    status: z.enum(["uploading", "failed", "cancelled", "file_required"]),
    updatedAt: utcDateTimeSchema,
    uploadedBytes: z.number().int().nonnegative().max(MAX_FILE_SIZE_BYTES),
  })
  .strict()
  .refine((value) => value.uploadedBytes <= value.sizeBytes, {
    message: "Uploaded bytes must not exceed file size",
  });

export type UploadCheckpoint = z.infer<typeof uploadCheckpointSchema>;

function getIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener(
      "success",
      () => {
        resolve(request.result);
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => {
        reject(new Error("IndexedDB request failed"));
      },
      { once: true },
    );
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener(
      "complete",
      () => {
        resolve();
      },
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => {
        reject(new Error("IndexedDB transaction aborted"));
      },
      {
        once: true,
      },
    );
    transaction.addEventListener(
      "error",
      () => {
        reject(new Error("IndexedDB transaction failed"));
      },
      {
        once: true,
      },
    );
  });
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: "jobId" });
    }
  });
  return requestResult(request);
}

export async function saveUploadCheckpoint(checkpoint: UploadCheckpoint): Promise<boolean> {
  const parsed = uploadCheckpointSchema.safeParse(checkpoint);
  const factory = getIndexedDb();
  if (!parsed.success || factory === undefined) {
    return false;
  }

  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(parsed.data);
    await transactionResult(transaction);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export async function removeUploadCheckpoint(jobId: string): Promise<boolean> {
  const idResult = ulidSchema.safeParse(jobId);
  const factory = getIndexedDb();
  if (!idResult.success || factory === undefined) {
    return false;
  }

  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(idResult.data);
    await transactionResult(transaction);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export async function loadUploadCheckpoints(): Promise<readonly UploadCheckpoint[]> {
  const factory = getIndexedDb();
  if (factory === undefined) {
    return [];
  }

  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(factory);
    const transaction = database.transaction(STORE_NAME, "readonly");
    const untrusted = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    await transactionResult(transaction);
    if (!Array.isArray(untrusted)) {
      return [];
    }
    return untrusted
      .map((value) => uploadCheckpointSchema.safeParse(value))
      .filter((result) => result.success)
      .map((result) => result.data)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  } finally {
    database?.close();
  }
}
