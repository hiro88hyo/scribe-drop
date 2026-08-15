const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const RUNTIME_SERVICE_ACCOUNT = "gpu-runtime@scribe-drop.iam.gserviceaccount.com";
const MODULE = "scribe_drop_worker.cloud_run_staging_bootstrap_preflight";
const SUCCESS_MARKER = "cloud-run-staging-bootstrap-preflight:ok:EXECUTION_NOT_FOUND";
const FAILURE_MARKER = "cloud-run-staging-bootstrap-preflight:failed";
const imagePattern =
  /^asia-southeast1-docker\.pkg\.dev\/scribe-drop\/worker\/runtime@sha256:[a-f0-9]{64}$/u;

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function createStagingBootstrapPreflightPlan(input) {
  const commit = requireString(input.commit, /^[a-f0-9]{40}$/u, "Candidate commit");
  if (commit !== input.expectedCommit) throw new Error("Candidate commit does not match");
  const workerImage = requireString(input.workerImage, imagePattern, "Candidate worker image");
  const runId = requireString(input.runId, /^[1-9][0-9]{0,19}$/u, "Workflow run ID");
  const runAttempt = requireString(input.runAttempt, /^[1-9][0-9]{0,5}$/u, "Workflow run attempt");
  const executionHandle = requireString(
    input.executionHandle,
    /^[A-Za-z0-9_-]{43}$/u,
    "Preflight execution handle",
  );
  const bootstrapRequestId = requireString(
    input.bootstrapRequestId,
    /^[0-9A-HJKMNP-TV-Z]{26}$/u,
    "Preflight bootstrap request ID",
  );
  const orchestratorOrigin = requireString(
    input.orchestratorOrigin,
    /^https:\/\/[a-z0-9.-]+$/u,
    "Staging Orchestrator origin",
  );
  const r2Host = requireString(
    input.r2Host,
    /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u,
    "Staging R2 host",
  );
  if (input.runtimeServiceAccount !== RUNTIME_SERVICE_ACCOUNT) {
    throw new Error("Staging runtime service account is invalid");
  }
  const jobId = `sd-stg-pf-${commit.slice(0, 7)}-${runId}-${runAttempt}`;
  if (jobId.length > 63) throw new Error("Preflight Job ID is invalid");
  return {
    bootstrapRequestId,
    environment: {
      APP_ENV: "staging",
      SCRIBE_DROP_BOOTSTRAP_REQUEST_ID: bootstrapRequestId,
      SCRIBE_DROP_EXECUTION_HANDLE: executionHandle,
      SCRIBE_DROP_EXECUTION_POLICY: "cloud_run_jobs_l4_v1",
      SCRIBE_DROP_IDENTITY_AUDIENCE: `${orchestratorOrigin}/internal/cloud-run/bootstrap`,
      SCRIBE_DROP_ORCHESTRATOR_ORIGIN: orchestratorOrigin,
      SCRIBE_DROP_RESULT_HOST: r2Host,
      SCRIBE_DROP_SOURCE_HOST: r2Host,
    },
    executionHandle,
    failureMarker: FAILURE_MARKER,
    jobId,
    labels: {
      "scribe-drop-environment": "staging",
      "scribe-drop-purpose": "bootstrap-preflight",
    },
    module: MODULE,
    projectId: PROJECT_ID,
    region: REGION,
    runtimeServiceAccount: RUNTIME_SERVICE_ACCOUNT,
    successMarker: SUCCESS_MARKER,
    workerImage,
  };
}

export function verifyStagingBootstrapPreflightJob(plan, untrustedJob) {
  const job =
    typeof untrustedJob === "object" && untrustedJob !== null && !Array.isArray(untrustedJob)
      ? untrustedJob
      : {};
  const jobTemplate = job.spec?.template?.spec;
  const task = jobTemplate?.template?.spec;
  const containers = task?.containers;
  const container =
    Array.isArray(containers) && containers.length === 1 ? containers[0] : undefined;
  const limits = container?.resources?.limits ?? {};
  const observedEnvironment = new Map(
    Array.isArray(container?.env) ? container.env.map(({ name, value }) => [name, value]) : [],
  );
  const expectedName = `projects/${plan.projectId}/locations/${plan.region}/jobs/${plan.jobId}`;
  if (
    !new Set([plan.jobId, expectedName]).has(job.metadata?.name) ||
    job.metadata?.labels?.["scribe-drop-environment"] !== "staging" ||
    job.metadata?.labels?.["scribe-drop-purpose"] !== "bootstrap-preflight" ||
    job.metadata?.annotations?.["run.googleapis.com/binary-authorization"] !== "default" ||
    Number(jobTemplate?.taskCount) !== 1 ||
    Number(jobTemplate?.parallelism) !== 1 ||
    container?.image !== plan.workerImage ||
    JSON.stringify(container?.command) !== JSON.stringify(["python"]) ||
    JSON.stringify(container?.args) !== JSON.stringify(["-m", plan.module]) ||
    String(limits.cpu) !== "1" ||
    limits.memory !== "512Mi" ||
    Object.hasOwn(limits, "nvidia.com/gpu") ||
    task?.nodeSelector?.accelerator !== undefined ||
    Number(task?.maxRetries) !== 0 ||
    task?.timeoutSeconds !== "60" ||
    task?.serviceAccountName !== plan.runtimeServiceAccount ||
    job.spec?.template?.metadata?.annotations?.["run.googleapis.com/execution-environment"] !==
      "gen2" ||
    observedEnvironment.size !== Object.keys(plan.environment).length ||
    Object.entries(plan.environment).some(
      ([name, value]) => observedEnvironment.get(name) !== value,
    )
  ) {
    throw new Error("GPU-free bootstrap preflight Job read-back does not match");
  }
  return { cpu: 1, gpu: 0, maxRetries: 0, memory: "512Mi", taskCount: 1 };
}

export function verifyStagingBootstrapPreflightMarkers(plan, untrustedEntries) {
  if (!Array.isArray(untrustedEntries)) throw new Error("GPU-free preflight log read is invalid");
  const markers = untrustedEntries.map((entry) => entry?.textPayload?.trim());
  const successCount = markers.filter((value) => value === plan.successMarker).length;
  const failureCount = markers.filter((value) => value === plan.failureMarker).length;
  if (successCount !== 1 || failureCount !== 0 || markers.length !== 1) {
    throw new Error("GPU-free preflight marker evidence is invalid");
  }
  return { failedMarkers: 0, okMarkers: 1, result: "EXECUTION_NOT_FOUND" };
}
