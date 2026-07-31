import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseStagingFailureEvidence(value) {
  const evidence = requireExactKeys(value, ["jobId", "schemaVersion"], "Staging failure evidence");
  if (evidence.schemaVersion !== 1 || !ulidPattern.test(evidence.jobId)) {
    throw new Error("Staging failure evidence is invalid");
  }
  return {
    schemaVersion: 1,
    jobId: evidence.jobId,
  };
}

export function parseWranglerD1Observation(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Staging D1 query result is invalid");
  }
  const operation = requireRecord(value[0], "Staging D1 operation");
  if (operation.success !== true || !Array.isArray(operation.results)) {
    throw new Error("Staging D1 operation failed");
  }
  if (operation.results.length === 0) {
    return undefined;
  }
  if (operation.results.length !== 1) {
    throw new Error("Staging failure query returned multiple jobs");
  }
  const row = requireExactKeys(
    operation.results[0],
    [
      "job_notified",
      "job_status",
      "job_version",
      "outbox_job_version",
      "outbox_sent",
      "outbox_status",
    ],
    "Staging failure notification row",
  );
  const outboxStatus = row.outbox_status;
  if (
    outboxStatus !== null &&
    (typeof outboxStatus !== "string" || !allowedOutboxStatuses.has(outboxStatus))
  ) {
    throw new Error("Staging notification outbox status is invalid");
  }
  const outboxJobVersion =
    row.outbox_job_version === null
      ? null
      : requirePositiveInteger(row.outbox_job_version, "Staging outbox job version");
  if (
    (row.job_notified !== 0 && row.job_notified !== 1) ||
    (row.outbox_sent !== 0 && row.outbox_sent !== 1)
  ) {
    throw new Error("Staging notification timestamps are invalid");
  }
  return {
    jobStatus: row.job_status,
    jobVersion: requirePositiveInteger(row.job_version, "Staging job version"),
    jobNotified: row.job_notified === 1,
    outboxJobVersion,
    outboxSent: row.outbox_sent === 1,
    outboxStatus,
  };
}

export async function waitForStagingFailureNotification(readObservation, options = {}) {
  const attempts = options.attempts ?? 12;
  const intervalMilliseconds = options.intervalMilliseconds ?? 5_000;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Staging notification attempt limit is invalid");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observation = await readObservation();
    if (observation === undefined) {
      throw new Error("Synthetic staging failure job is missing");
    }
    if (observation.jobStatus !== "FAILED") {
      throw new Error("Synthetic staging failure job is not FAILED");
    }
    if (observation.outboxStatus === "DEAD") {
      throw new Error("Synthetic staging failure notification is dead");
    }
    if (
      observation.outboxStatus === "SENT" &&
      observation.outboxJobVersion === observation.jobVersion &&
      observation.outboxSent &&
      observation.jobNotified
    ) {
      return observation;
    }
    if (attempt < attempts) {
      await sleep(intervalMilliseconds);
    }
  }
  throw new Error("Synthetic staging failure notification was not delivered in time");
}

function failureQuery(jobId) {
  if (!ulidPattern.test(jobId)) {
    throw new Error("Staging failure job ID is invalid");
  }
  return `
    SELECT
      jobs.status AS job_status,
      jobs.version AS job_version,
      CASE WHEN jobs.notified_at IS NULL THEN 0 ELSE 1 END AS job_notified,
      notification_outbox.status AS outbox_status,
      notification_outbox.job_version AS outbox_job_version,
      CASE WHEN notification_outbox.sent_at IS NULL THEN 0 ELSE 1 END AS outbox_sent
    FROM jobs
    LEFT JOIN notification_outbox
      ON notification_outbox.job_id = jobs.id
    WHERE jobs.id = '${jobId}'
    LIMIT 2;
  `;
}

export function createWranglerD1Arguments(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Staging D1 command input is invalid");
  }
  if (typeof input.configPath !== "string" || !path.isAbsolute(input.configPath)) {
    throw new Error("Staging Wrangler configuration path is invalid");
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
    failureQuery(input.jobId),
    "--json",
  ];
}

export function readRemoteStagingFailureObservation(input) {
  const result = spawnSync("pnpm", createWranglerD1Arguments(input), {
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
    throw new Error("Staging D1 notification query failed");
  }
  return parseWranglerD1Observation(JSON.parse(result.stdout));
}

export function readStagingFailureEvidenceFile(evidencePath) {
  return parseStagingFailureEvidence(JSON.parse(readFileSync(evidencePath, "utf8")));
}
