import { spawnSync } from "node:child_process";
import path from "node:path";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const allowedOutboxStatuses = new Set(["DEAD", "PENDING", "SENDING", "SENT"]);

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const record = requireRecord(value, label);
  const actualKeys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
  return record;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

export function stagingCompletionQuery(jobId) {
  if (!ulidPattern.test(jobId)) throw new Error("Staging completion job ID is invalid");
  return `
    SELECT
      jobs.status AS job_status,
      jobs.version AS job_version,
      jobs.duration_seconds,
      CASE WHEN jobs.notified_at IS NULL THEN 0 ELSE 1 END AS job_notified,
      attempts.status AS attempt_status,
      attempts.provider_kind,
      attempts.provider_policy,
      attempts.runpod_execution_ms,
      notification_outbox.status AS outbox_status,
      notification_outbox.job_version AS outbox_job_version,
      CASE WHEN notification_outbox.sent_at IS NULL THEN 0 ELSE 1 END AS outbox_sent
    FROM jobs
    INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
    LEFT JOIN notification_outbox ON notification_outbox.job_id = jobs.id
    WHERE jobs.id = '${jobId}'
    LIMIT 2;
  `;
}

export function parseStagingCompletionObservation(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Staging completion D1 result is invalid");
  }
  const operation = requireRecord(value[0], "Staging completion D1 operation");
  if (operation.success !== true || !Array.isArray(operation.results)) {
    throw new Error("Staging completion D1 operation failed");
  }
  if (operation.results.length === 0) return undefined;
  if (operation.results.length !== 1) {
    throw new Error("Staging completion query returned multiple jobs");
  }
  const row = requireExactKeys(
    operation.results[0],
    [
      "attempt_status",
      "duration_seconds",
      "job_notified",
      "job_status",
      "job_version",
      "outbox_job_version",
      "outbox_sent",
      "outbox_status",
      "provider_kind",
      "provider_policy",
      "runpod_execution_ms",
    ],
    "Staging completion notification row",
  );
  if (
    typeof row.duration_seconds !== "number" ||
    !Number.isFinite(row.duration_seconds) ||
    row.duration_seconds <= 0
  ) {
    throw new Error("Staging completion media duration is invalid");
  }
  if (
    row.outbox_status !== null &&
    (typeof row.outbox_status !== "string" || !allowedOutboxStatuses.has(row.outbox_status))
  ) {
    throw new Error("Staging completion outbox status is invalid");
  }
  if (
    (row.job_notified !== 0 && row.job_notified !== 1) ||
    (row.outbox_sent !== 0 && row.outbox_sent !== 1)
  ) {
    throw new Error("Staging completion notification timestamps are invalid");
  }
  return {
    attemptStatus: row.attempt_status,
    durationSeconds: row.duration_seconds,
    jobNotified: row.job_notified === 1,
    jobStatus: row.job_status,
    jobVersion: requirePositiveInteger(row.job_version, "Staging completion job version"),
    outboxJobVersion:
      row.outbox_job_version === null
        ? null
        : requirePositiveInteger(row.outbox_job_version, "Staging completion outbox job version"),
    outboxSent: row.outbox_sent === 1,
    outboxStatus: row.outbox_status,
    processingMilliseconds: requirePositiveInteger(
      row.runpod_execution_ms,
      "Staging completion processing time",
    ),
    providerKind: row.provider_kind,
    providerPolicy: row.provider_policy,
  };
}

export async function waitForStagingCompletionNotification(readObservation, options = {}) {
  const attempts = options.attempts ?? 90;
  const intervalMilliseconds = options.intervalMilliseconds ?? 5_000;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Staging completion attempt limit is invalid");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observation = await readObservation();
    if (observation === undefined) throw new Error("Staging completion job is missing");
    if (
      observation.jobStatus !== "COMPLETED" ||
      observation.attemptStatus !== "COMPLETED" ||
      observation.providerKind !== "cloud_run_jobs" ||
      observation.providerPolicy !== "cloud_run_jobs_l4_v1"
    ) {
      throw new Error("Staging completion does not match the Cloud Run lifecycle");
    }
    if (observation.outboxStatus === "DEAD") {
      throw new Error("Staging completion notification is dead");
    }
    if (
      observation.outboxStatus === "SENT" &&
      observation.outboxJobVersion === observation.jobVersion &&
      observation.outboxSent &&
      observation.jobNotified
    ) {
      return observation;
    }
    if (attempt < attempts) await sleep(intervalMilliseconds);
  }
  throw new Error("Staging completion notification was not delivered in time");
}

export function createStagingCompletionD1Arguments(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Staging completion D1 input is invalid");
  }
  if (typeof input.configPath !== "string" || !path.isAbsolute(input.configPath)) {
    throw new Error("Staging completion Wrangler configuration path is invalid");
  }
  return [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--remote",
    "--config",
    input.configPath,
    "--env",
    "staging",
    "--command",
    stagingCompletionQuery(input.jobId),
    "--json",
  ];
}

export function readRemoteStagingCompletionObservation(input) {
  const result = spawnSync("pnpm", createStagingCompletionD1Arguments(input), {
    cwd: input.repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: input.cloudflareApiToken,
      WRANGLER_WRITE_LOGS: "0",
    },
    timeout: 30_000,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error("Staging completion D1 query failed");
  }
  return parseStagingCompletionObservation(JSON.parse(result.stdout));
}
