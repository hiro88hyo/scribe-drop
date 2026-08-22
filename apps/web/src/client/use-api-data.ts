import { ACTIVE_JOB_STATUSES } from "@scribe-drop/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobDetail, JobStatus, JobSummary, MeResponse } from "@scribe-drop/contracts";

import { apiClient } from "./api-client.js";
import { toUiError, type UiError } from "./job-presentation.js";

const JOB_POLL_INTERVAL_MILLISECONDS = 5000;
const MAX_CONSECUTIVE_JOB_POLL_FAILURES = 3;
const activeStatuses: ReadonlySet<JobStatus> = new Set(ACTIVE_JOB_STATUSES);

export type ResourceState<Value> =
  | {
      readonly status: "loading";
    }
  | {
      readonly error: UiError;
      readonly status: "error";
    }
  | {
      readonly status: "ready";
      readonly value: Value;
    };

export interface JobHistoryState {
  readonly error?: UiError;
  readonly items: readonly JobSummary[];
  readonly loadingMore: boolean;
  readonly nextCursor: string | null;
  readonly status: "error" | "loading" | "ready";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSession(): {
  readonly retry: () => void;
  readonly state: ResourceState<MeResponse>;
} {
  const [retrySequence, setRetrySequence] = useState(0);
  const [state, setState] = useState<ResourceState<MeResponse>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void apiClient
      .getMe(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", value });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState({ error: toUiError(error), status: "error" });
        }
      });
    return () => {
      controller.abort();
    };
  }, [retrySequence]);

  return {
    retry: () => {
      setRetrySequence((current) => current + 1);
    },
    state,
  };
}

export function useRecentJobs(limit: number): {
  readonly retry: () => void;
  readonly state: ResourceState<readonly JobSummary[]>;
} {
  const [retrySequence, setRetrySequence] = useState(0);
  const [state, setState] = useState<ResourceState<readonly JobSummary[]>>({
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void apiClient
      .listJobs({ limit }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", value: response.items });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState({ error: toUiError(error), status: "error" });
        }
      });
    return () => {
      controller.abort();
    };
  }, [limit, retrySequence]);

  return {
    retry: () => {
      setRetrySequence((current) => current + 1);
    },
    state,
  };
}

export function useJobHistory(limit: number): {
  readonly loadMore: () => void;
  readonly retry: () => void;
  readonly state: JobHistoryState;
} {
  const [retrySequence, setRetrySequence] = useState(0);
  const loadMoreController = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<JobHistoryState>({
    items: [],
    loadingMore: false,
    nextCursor: null,
    status: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    setState({
      items: [],
      loadingMore: false,
      nextCursor: null,
      status: "loading",
    });
    void apiClient
      .listJobs({ limit }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setState({
            items: response.items,
            loadingMore: false,
            nextCursor: response.nextCursor,
            status: "ready",
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState({
            error: toUiError(error),
            items: [],
            loadingMore: false,
            nextCursor: null,
            status: "error",
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [limit, retrySequence]);

  const loadMore = useCallback(() => {
    if (state.status !== "ready" || state.nextCursor === null || state.loadingMore) {
      return;
    }

    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setState((current) => ({ ...current, loadingMore: true }));
    void apiClient
      .listJobs({ cursor: state.nextCursor, limit }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            items: [...current.items, ...response.items],
            loadingMore: false,
            nextCursor: response.nextCursor,
            status: "ready",
          }));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState((current) => ({
            ...current,
            error: toUiError(error),
            loadingMore: false,
          }));
        }
      });
  }, [limit, state]);

  useEffect(
    () => () => {
      loadMoreController.current?.abort();
    },
    [],
  );

  return {
    loadMore,
    retry: () => {
      setRetrySequence((current) => current + 1);
    },
    state,
  };
}

export function useJobDetail(jobId: string | undefined): {
  readonly retry: () => void;
  readonly state: ResourceState<JobDetail>;
} {
  const [retrySequence, setRetrySequence] = useState(0);
  const [state, setState] = useState<ResourceState<JobDetail>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let retryPollingAfterFailure = false;
    let consecutivePollingFailures = 0;

    const load = async (): Promise<void> => {
      if (jobId === undefined) {
        setState({
          error: { message: "指定されたジョブは見つかりません。" },
          status: "error",
        });
        return;
      }
      try {
        const value = await apiClient.getJob(jobId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setState({ status: "ready", value });
        consecutivePollingFailures = 0;
        retryPollingAfterFailure = activeStatuses.has(value.status);
        if (retryPollingAfterFailure) {
          pollTimer = setTimeout(() => {
            void load();
          }, JOB_POLL_INTERVAL_MILLISECONDS);
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          if (retryPollingAfterFailure) {
            consecutivePollingFailures += 1;
            if (consecutivePollingFailures < MAX_CONSECUTIVE_JOB_POLL_FAILURES) {
              pollTimer = setTimeout(() => {
                void load();
              }, JOB_POLL_INTERVAL_MILLISECONDS);
            } else {
              setState({ error: toUiError(error), status: "error" });
            }
          } else {
            setState({ error: toUiError(error), status: "error" });
          }
        }
      }
    };

    setState({ status: "loading" });
    void load();
    return () => {
      controller.abort();
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
      }
    };
  }, [jobId, retrySequence]);

  return {
    retry: () => {
      setRetrySequence((current) => current + 1);
    },
    state,
  };
}
