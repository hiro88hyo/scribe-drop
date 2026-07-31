import {
  validateCreatedRunpodEndpoint,
  validateRunpodEndpointCapacity,
  validateRunpodPlan,
} from "./runpod-environment-config.mjs";

export const STAGING_RUNPOD_PREWARM_TIMEOUT_MS = 8 * 60 * 1_000;
export const STAGING_RUNPOD_PREWARM_POLL_INTERVAL_MS = 15_000;
export const STAGING_RUNPOD_STALE_RUNNING_CONFIRMATIONS = 3;

const terminalWorkerStatuses = new Set(["EXITED", "TERMINATED"]);
const resourceIdPattern = /^[A-Za-z0-9_-]{3,128}$/u;
const runpodWorkerStartPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,9} [+-]\d{4} UTC$/u;

class RunpodPrewarmReadinessTimeoutError extends Error {
  constructor(observation) {
    const details =
      observation === undefined
        ? "observation=unavailable"
        : [
            `mode=${observation.mode}`,
            `active=${String(observation.active)}`,
            `jobsInProgress=${String(observation.jobsInProgress)}`,
            `jobsInQueue=${String(observation.jobsInQueue)}`,
            `idle=${String(observation.idle)}`,
            `ready=${String(observation.ready)}`,
            `running=${String(observation.running)}`,
            `initializing=${String(observation.initializing)}`,
            `throttled=${String(observation.throttled)}`,
            `unhealthy=${String(observation.unhealthy)}`,
            `refreshConfirmed=${String(observation.refreshConfirmed)}`,
            `stableRunning=${String(observation.stableRunning)}`,
          ].join(",");
    super(`RunPod staging candidate worker did not become ready (${details})`);
    this.name = "RunpodPrewarmReadinessTimeoutError";
  }
}

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireWorkerEvidence(untrustedWorker) {
  const worker = requireRecord(untrustedWorker, "RunPod active worker");
  if (typeof worker.id !== "string" || !resourceIdPattern.test(worker.id)) {
    throw new Error("RunPod active worker ID is missing or invalid");
  }
  if (
    typeof worker.lastStartedAt !== "string" ||
    !runpodWorkerStartPattern.test(worker.lastStartedAt)
  ) {
    throw new Error("RunPod active worker start time is missing or invalid");
  }
  const lastStartedAtMs = Date.parse(worker.lastStartedAt);
  if (!Number.isSafeInteger(lastStartedAtMs) || lastStartedAtMs < 0) {
    throw new Error("RunPod active worker start time is missing or invalid");
  }
  return { id: worker.id, lastStartedAtMs };
}

export function validateRunpodWorkerEvidence(untrustedEvidence) {
  const evidence = requireRecord(untrustedEvidence, "RunPod worker evidence");
  if (
    typeof evidence.id !== "string" ||
    !resourceIdPattern.test(evidence.id) ||
    !Number.isSafeInteger(evidence.lastStartedAtMs) ||
    evidence.lastStartedAtMs < 0 ||
    Object.keys(evidence).some((key) => key !== "id" && key !== "lastStartedAtMs")
  ) {
    throw new Error("RunPod worker evidence is missing or invalid");
  }
  return { id: evidence.id, lastStartedAtMs: evidence.lastStartedAtMs };
}

function validateActiveWorkerEndpoint(
  untrustedEndpoint,
  plan,
  endpointId,
  templateId,
  expectedWorkersMin,
) {
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  if (endpoint.id !== endpointId) {
    throw new Error("RunPod endpoint active worker read-back targeted a different endpoint");
  }
  if ((endpoint.workersMin ?? 0) !== expectedWorkersMin) {
    throw new Error("RunPod endpoint active worker read-back did not match");
  }
  validateCreatedRunpodEndpoint(
    {
      ...endpoint,
      workersMin: plan.endpoint.workersMin,
    },
    plan,
    templateId,
  );
  const workers = endpoint.workers ?? [];
  if (!Array.isArray(workers)) {
    throw new Error("RunPod endpoint worker read-back is missing or invalid");
  }
  const activeWorkers = workers.filter((untrustedWorker) => {
    const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
    return !terminalWorkerStatuses.has(worker.desiredStatus);
  });
  if (
    activeWorkers.some((untrustedWorker) => {
      const worker = requireRecord(untrustedWorker, "RunPod endpoint worker");
      return (
        worker.desiredStatus !== "RUNNING" ||
        worker.templateId !== templateId ||
        worker.imageName !== plan.template.image
      );
    })
  ) {
    throw new Error("RunPod active worker does not match the release candidate");
  }
  return activeWorkers;
}

function validateCooldownEndpoint(untrustedEndpoint, input, plan) {
  const endpoint = requireRecord(untrustedEndpoint, "RunPod endpoint response");
  if (endpoint.id !== input.endpointId || endpoint.name !== plan.endpoint.name) {
    throw new Error("RunPod cooldown endpoint identity did not match");
  }
  const workersMin = endpoint.workersMin ?? 0;
  if (workersMin !== 0 && workersMin !== 1) {
    throw new Error("RunPod endpoint active worker read-back did not match");
  }
  return workersMin;
}

function validateInputs(input, requireTemplate) {
  const plan = validateRunpodPlan(input.plan, "staging");
  if (
    plan.endpoint.workersMin !== 0 ||
    plan.endpoint.workersMax !== 1 ||
    typeof input.endpointId !== "string" ||
    !resourceIdPattern.test(input.endpointId) ||
    (requireTemplate &&
      (typeof input.templateId !== "string" || !resourceIdPattern.test(input.templateId)))
  ) {
    throw new Error("RunPod staging active worker inputs are invalid");
  }
  return plan;
}

function validateDependencies(dependencies, requireHealth) {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    typeof dependencies.getEndpoint !== "function" ||
    typeof dependencies.setWorkersMin !== "function" ||
    (requireHealth &&
      (typeof dependencies.getCapacity !== "function" ||
        typeof dependencies.getHealth !== "function"))
  ) {
    throw new Error("RunPod staging active worker dependencies are invalid");
  }
}

async function readEndpoint(input, dependencies) {
  return dependencies.getEndpoint({ endpointId: input.endpointId });
}

async function setWorkersMinAndReadBack(input, dependencies, plan, currentEndpoint, workersMin) {
  const currentWorkersMin =
    requireRecord(currentEndpoint, "RunPod endpoint response").workersMin ?? 0;
  if (currentWorkersMin !== workersMin) {
    try {
      await dependencies.setWorkersMin({
        endpointId: input.endpointId,
        workersMin,
      });
    } catch {
      // Mutation responses are never retried. Exact read-back is authoritative.
    }
  }
  const endpoint = await readEndpoint(input, dependencies);
  validateActiveWorkerEndpoint(endpoint, plan, input.endpointId, input.templateId, workersMin);
  return endpoint;
}

export async function cooldownStagingRunpodCandidate(input, dependencies) {
  const plan = validateInputs(input, false);
  validateDependencies(dependencies, false);
  const endpoint = await readEndpoint(input, dependencies);
  const workersMin = validateCooldownEndpoint(endpoint, input, plan);
  if (workersMin !== 0) {
    try {
      await dependencies.setWorkersMin({
        endpointId: input.endpointId,
        workersMin: 0,
      });
    } catch {
      // Mutation responses are never retried. Exact read-back is authoritative.
    }
  }
  if (validateCooldownEndpoint(await readEndpoint(input, dependencies), input, plan) !== 0) {
    throw new Error("RunPod scale-to-zero read-back did not match");
  }
}

export async function prewarmStagingRunpodCandidate(input, dependencies) {
  const plan = validateInputs(input, true);
  validateDependencies(dependencies, true);
  const previousWorker =
    input.previousWorker === undefined
      ? undefined
      : validateRunpodWorkerEvidence(input.previousWorker);
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error("RunPod staging prewarm clock is invalid");
  }
  let lastObservation;
  let stableRunningConfirmations = 0;
  let stableRunningEvidence;

  try {
    validateRunpodEndpointCapacity(
      await dependencies.getCapacity({ endpointId: input.endpointId }),
      plan,
    );
    const endpoint = await readEndpoint(input, dependencies);
    const workersMin = requireRecord(endpoint, "RunPod endpoint response").workersMin ?? 0;
    if (workersMin !== 0 && workersMin !== 1) {
      throw new Error("RunPod endpoint active worker read-back did not match");
    }
    await setWorkersMinAndReadBack(input, dependencies, plan, endpoint, 1);

    while (true) {
      const [currentEndpoint, health] = await Promise.all([
        readEndpoint(input, dependencies),
        dependencies.getHealth({ endpointId: input.endpointId }),
      ]);
      const activeWorkers = validateActiveWorkerEndpoint(
        currentEndpoint,
        plan,
        input.endpointId,
        input.templateId,
        1,
      );
      const workers = requireRecord(
        requireRecord(health, "RunPod endpoint health").workers,
        "RunPod endpoint health workers",
      );
      const jobs = requireRecord(
        requireRecord(health, "RunPod endpoint health").jobs,
        "RunPod endpoint health jobs",
      );
      const inProgressJobCount = requireCounter(jobs.inProgress, "RunPod in-progress job count");
      const queuedJobCount = requireCounter(jobs.inQueue, "RunPod queued job count");
      const idleWorkerCount = requireCounter(workers.idle, "RunPod idle worker count");
      const initializingWorkerCount = requireCounter(
        workers.initializing,
        "RunPod initializing worker count",
      );
      const readyWorkerCount = requireCounter(workers.ready, "RunPod ready worker count");
      const idleOrReadyWorkerCount = idleWorkerCount + readyWorkerCount;
      const runningWorkerCount = requireCounter(workers.running, "RunPod running worker count");
      const throttledWorkerCount = requireCounter(
        workers.throttled,
        "RunPod throttled worker count",
      );
      const unhealthyWorkerCount = requireCounter(
        workers.unhealthy,
        "RunPod unhealthy worker count",
      );
      const normalReadyState = idleOrReadyWorkerCount >= 1 && runningWorkerCount === 0;
      const staleRunningState = idleOrReadyWorkerCount === 0 && runningWorkerCount === 1;
      const workerEvidence =
        activeWorkers.length === 1 && (normalReadyState || staleRunningState)
          ? requireWorkerEvidence(activeWorkers[0])
          : undefined;
      const refreshConfirmed =
        previousWorker === undefined ||
        (workerEvidence !== undefined &&
          workerEvidence.id === previousWorker.id &&
          workerEvidence.lastStartedAtMs > previousWorker.lastStartedAtMs);
      const zeroJobsAndAbnormalStates =
        inProgressJobCount === 0 &&
        initializingWorkerCount === 0 &&
        queuedJobCount === 0 &&
        throttledWorkerCount === 0 &&
        unhealthyWorkerCount === 0;
      if (
        staleRunningState &&
        workerEvidence !== undefined &&
        refreshConfirmed &&
        zeroJobsAndAbnormalStates
      ) {
        if (
          stableRunningEvidence?.id === workerEvidence.id &&
          stableRunningEvidence.lastStartedAtMs === workerEvidence.lastStartedAtMs
        ) {
          stableRunningConfirmations += 1;
        } else {
          stableRunningEvidence = workerEvidence;
          stableRunningConfirmations = 1;
        }
      } else {
        stableRunningEvidence = undefined;
        stableRunningConfirmations = 0;
      }
      const stableRunningReadyState =
        staleRunningState &&
        stableRunningConfirmations >= STAGING_RUNPOD_STALE_RUNNING_CONFIRMATIONS;
      lastObservation = {
        active: activeWorkers.length,
        idle: idleWorkerCount,
        initializing: initializingWorkerCount,
        jobsInProgress: inProgressJobCount,
        jobsInQueue: queuedJobCount,
        mode: previousWorker === undefined ? "initial" : "post-refresh",
        ready: readyWorkerCount,
        refreshConfirmed,
        running: runningWorkerCount,
        stableRunning: stableRunningConfirmations,
        throttled: throttledWorkerCount,
        unhealthy: unhealthyWorkerCount,
      };
      if (
        activeWorkers.length === 1 &&
        (normalReadyState || stableRunningReadyState) &&
        refreshConfirmed &&
        zeroJobsAndAbnormalStates
      ) {
        validateRunpodEndpointCapacity(
          await dependencies.getCapacity({ endpointId: input.endpointId }),
          plan,
        );
        return workerEvidence;
      }

      const currentTime = now();
      if (
        !Number.isSafeInteger(currentTime) ||
        currentTime < startedAt ||
        currentTime - startedAt >= STAGING_RUNPOD_PREWARM_TIMEOUT_MS
      ) {
        throw new RunpodPrewarmReadinessTimeoutError(lastObservation);
      }
      await sleep(
        Math.min(
          STAGING_RUNPOD_PREWARM_POLL_INTERVAL_MS,
          STAGING_RUNPOD_PREWARM_TIMEOUT_MS - (currentTime - startedAt),
        ),
      );
    }
  } catch (error) {
    try {
      await cooldownStagingRunpodCandidate(input, dependencies);
    } catch (rollbackError) {
      throw new Error("RunPod staging prewarm failed and scale-to-zero rollback failed", {
        cause: rollbackError,
      });
    }
    const readinessDetails =
      error instanceof RunpodPrewarmReadinessTimeoutError ? `: ${error.message}` : "";
    throw new Error(
      `RunPod staging prewarm failed; scale-to-zero was restored${readinessDetails}`,
      {
        cause: error,
      },
    );
  }
}
