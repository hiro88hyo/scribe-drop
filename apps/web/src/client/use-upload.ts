import type { CreateJobRequest } from "@scribe-drop/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "./api-client.js";
import { toUiError, type UiError } from "./job-presentation.js";
import {
  MultipartUploadError,
  uploadFileMultipart,
  type MultipartUploadProgress,
} from "./multipart-uploader.js";
import {
  loadUploadCheckpoints,
  removeUploadCheckpoint,
  saveUploadCheckpoint,
  type UploadCheckpoint,
} from "./upload-checkpoints.js";

export interface UploadStartInput {
  readonly file: File;
  readonly request: CreateJobRequest;
}

export type UploadState =
  | {
      readonly status: "idle";
    }
  | {
      readonly filename: string;
      readonly status: "preparing";
    }
  | {
      readonly filename: string;
      readonly jobId: string;
      readonly progress: MultipartUploadProgress;
      readonly status: "uploading";
    }
  | {
      readonly cancelled: boolean;
      readonly error: UiError;
      readonly filename: string;
      readonly retryable: boolean;
      readonly status: "error";
    }
  | {
      readonly eTag: string;
      readonly filename: string;
      readonly jobId: string;
      readonly status: "uploaded";
    };

function isActive(state: UploadState): boolean {
  return state.status === "preparing" || state.status === "uploading";
}

async function requestWakeLock(): Promise<WakeLockSentinel | undefined> {
  try {
    return await navigator.wakeLock.request("screen");
  } catch {
    return undefined;
  }
}

function checkpointFrom(
  jobId: string,
  input: UploadStartInput,
  status: UploadCheckpoint["status"],
  uploadedBytes: number,
): UploadCheckpoint {
  return {
    contentType: input.request.contentType,
    filename: input.file.name,
    jobId,
    sizeBytes: input.file.size,
    status,
    updatedAt: new Date().toISOString(),
    uploadedBytes,
  };
}

function uploadError(error: unknown): {
  readonly cancelled: boolean;
  readonly error: UiError;
} {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      cancelled: true,
      error: {
        message: "アップロードをキャンセルしました。",
      },
    };
  }
  if (error instanceof MultipartUploadError) {
    return {
      cancelled: error.kind === "aborted",
      error: {
        message:
          error.kind === "aborted"
            ? "アップロードをキャンセルしました。"
            : "通信を確認して、もう一度アップロードしてください。",
      },
    };
  }
  return {
    cancelled: false,
    error: toUiError(error),
  };
}

export function useUpload(): {
  readonly cancel: () => void;
  readonly dismissCheckpoint: (jobId: string) => void;
  readonly recoveredCheckpoints: readonly UploadCheckpoint[];
  readonly retry: () => void;
  readonly start: (input: UploadStartInput) => void;
  readonly state: UploadState;
} {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [recoveredCheckpoints, setRecoveredCheckpoints] = useState<readonly UploadCheckpoint[]>([]);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const lastInputRef = useRef<UploadStartInput | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void loadUploadCheckpoints().then((checkpoints) => {
      if (!mountedRef.current) {
        return;
      }
      const recovered = checkpoints.map((checkpoint) => ({
        ...checkpoint,
        status: "file_required" as const,
      }));
      setRecoveredCheckpoints(recovered);
      for (const checkpoint of recovered) {
        void saveUploadCheckpoint(checkpoint);
      }
    });
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isActive(state)) {
      return;
    }
    const preventNavigation = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventNavigation);
    return () => {
      window.removeEventListener("beforeunload", preventNavigation);
    };
  }, [state]);

  const run = useCallback(async (input: UploadStartInput): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    lastInputRef.current = input;
    setState({ filename: input.file.name, status: "preparing" });

    let jobId: string | undefined;
    let lastUploadedBytes = 0;
    let wakeLock: WakeLockSentinel | undefined;
    try {
      const session = await apiClient.getMe(controller.signal);
      const created = await apiClient.createJob(
        input.request,
        session.csrfToken,
        controller.signal,
      );
      jobId = created.jobId;
      await saveUploadCheckpoint(checkpointFrom(jobId, input, "uploading", 0));
      wakeLock = await requestWakeLock();

      const result = await uploadFileMultipart({
        credentials: created.upload,
        file: input.file,
        onProgress: (progress) => {
          lastUploadedBytes = progress.uploadedBytes;
          if (!controller.signal.aborted && mountedRef.current && jobId !== undefined) {
            setState({
              filename: input.file.name,
              jobId,
              progress,
              status: "uploading",
            });
            void saveUploadCheckpoint(
              checkpointFrom(jobId, input, "uploading", progress.uploadedBytes),
            );
          }
        },
        signal: controller.signal,
      });
      await removeUploadCheckpoint(jobId);
      if (!controller.signal.aborted && mountedRef.current) {
        setState({
          eTag: result.eTag,
          filename: input.file.name,
          jobId,
          status: "uploaded",
        });
      }
    } catch (error) {
      const presentation = uploadError(error);
      if (jobId !== undefined) {
        await saveUploadCheckpoint(
          checkpointFrom(
            jobId,
            input,
            presentation.cancelled ? "cancelled" : "failed",
            lastUploadedBytes,
          ),
        );
      }
      if (mountedRef.current) {
        setState({
          cancelled: presentation.cancelled,
          error: presentation.error,
          filename: input.file.name,
          retryable: true,
          status: "error",
        });
      }
    } finally {
      if (wakeLock !== undefined && !wakeLock.released) {
        try {
          await wakeLock.release();
        } catch {
          // A released or invalidated wake lock needs no further cleanup.
        }
      }
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
    }
  }, []);

  return {
    cancel: () => {
      controllerRef.current?.abort();
    },
    dismissCheckpoint: (jobId) => {
      void removeUploadCheckpoint(jobId);
      setRecoveredCheckpoints((current) =>
        current.filter((checkpoint) => checkpoint.jobId !== jobId),
      );
    },
    recoveredCheckpoints,
    retry: () => {
      const input = lastInputRef.current;
      if (input !== undefined) {
        void run(input);
      }
    },
    start: (input) => {
      void run(input);
    },
    state,
  };
}
