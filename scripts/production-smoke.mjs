import path from "node:path";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const expectedFormats = new Set(["json", "markdown", "srt"]);

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function productionSmokeQuery(jobId) {
  if (!ulidPattern.test(jobId)) throw new Error("Production smoke job ID is invalid");
  return `
    SELECT
      jobs.id AS job_id,
      jobs.source_key,
      jobs.status AS job_status,
      CASE WHEN jobs.notified_at IS NULL THEN 0 ELSE 1 END AS job_notified,
      attempts.id AS attempt_id,
      attempts.result_prefix,
      attempts.status AS attempt_status,
      attempts.provider_kind,
      attempts.provider_policy,
      executions.status AS execution_status,
      executions.terminal_status,
      executions.cleanup_status,
      notification_outbox.status AS outbox_status,
      CASE WHEN notification_outbox.sent_at IS NULL THEN 0 ELSE 1 END AS outbox_sent,
      artifacts.format,
      artifacts.object_key,
      artifacts.size_bytes,
      artifacts.sha256,
      (
        SELECT COUNT(*)
        FROM cloud_run_runtime_bootstraps AS bootstraps
        INNER JOIN cloud_run_runtime_events AS events
          ON events.bootstrap_request_id = bootstraps.bootstrap_request_id
        WHERE bootstraps.execution_id = executions.id
          AND events.kind = 'terminal'
          AND events.terminal_status = 'succeeded'
          AND events.terminal_error_code IS NULL
          AND events.artifact_count = 3
          AND events.manifest_written = 1
      ) AS successful_terminal_count
    FROM jobs
    INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
    INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
    INNER JOIN job_artifacts AS artifacts ON artifacts.attempt_id = attempts.id
    INNER JOIN notification_outbox ON notification_outbox.job_id = jobs.id
    WHERE jobs.id = '${jobId}'
    ORDER BY artifacts.format
    LIMIT 4;
  `;
}

export function parseProductionSmokeObservation(value, expectedJobId) {
  if (!ulidPattern.test(expectedJobId) || !Array.isArray(value) || value.length !== 1) {
    throw new Error("Production smoke D1 result is invalid");
  }
  const operation = requireRecord(value[0], "Production smoke D1 operation");
  if (operation.success !== true || !Array.isArray(operation.results)) {
    throw new Error("Production smoke D1 operation failed");
  }
  if (operation.results.length !== 3) {
    throw new Error("Production smoke must contain exactly three artifacts");
  }
  const formats = new Set();
  let attemptId;
  let resultPrefix;
  let sourceKey;
  const objectKeys = [];
  for (const untrustedRow of operation.results) {
    const row = requireRecord(untrustedRow, "Production smoke row");
    if (
      row.job_id !== expectedJobId ||
      row.job_status !== "COMPLETED" ||
      row.job_notified !== 1 ||
      row.attempt_status !== "COMPLETED" ||
      row.provider_kind !== "cloud_run_jobs" ||
      row.provider_policy !== "cloud_run_jobs_l4_v1" ||
      row.execution_status !== "TERMINAL" ||
      row.terminal_status !== "COMPLETED" ||
      row.cleanup_status !== "SUCCEEDED" ||
      row.outbox_status !== "SENT" ||
      row.outbox_sent !== 1 ||
      row.successful_terminal_count !== 1 ||
      !ulidPattern.test(row.attempt_id) ||
      typeof row.source_key !== "string" ||
      typeof row.result_prefix !== "string" ||
      !row.result_prefix.startsWith("results/") ||
      typeof row.format !== "string" ||
      !expectedFormats.has(row.format) ||
      typeof row.object_key !== "string" ||
      !row.object_key.startsWith(row.result_prefix) ||
      !Number.isSafeInteger(row.size_bytes) ||
      row.size_bytes <= 0 ||
      typeof row.sha256 !== "string" ||
      !sha256Pattern.test(row.sha256)
    ) {
      throw new Error("Production smoke row does not match the completed Cloud Run lifecycle");
    }
    if (
      (attemptId !== undefined && attemptId !== row.attempt_id) ||
      (resultPrefix !== undefined && resultPrefix !== row.result_prefix) ||
      (sourceKey !== undefined && sourceKey !== row.source_key) ||
      formats.has(row.format)
    ) {
      throw new Error("Production smoke artifact identity is inconsistent");
    }
    attemptId = row.attempt_id;
    resultPrefix = row.result_prefix;
    sourceKey = row.source_key;
    formats.add(row.format);
    objectKeys.push(row.object_key);
  }
  if (
    formats.size !== expectedFormats.size ||
    resultPrefix === undefined ||
    sourceKey === undefined
  ) {
    throw new Error("Production smoke artifact set is incomplete");
  }
  return {
    artifactKeys: objectKeys.sort(),
    attemptId,
    manifestKey: `${resultPrefix}manifest.json`,
    sourceKey,
  };
}

export function createProductionSmokeD1Arguments(jobId, configPath) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw new Error("Production Wrangler configuration path is invalid");
  }
  return [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--remote",
    "--config",
    configPath,
    "--env",
    "production",
    "--command",
    productionSmokeQuery(jobId),
    "--json",
  ];
}
