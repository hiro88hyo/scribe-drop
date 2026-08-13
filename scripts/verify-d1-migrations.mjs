import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const orchestratorConfig = path.join(repositoryRoot, "apps", "orchestrator", "wrangler.toml");
const webConfig = path.join(repositoryRoot, "apps", "web", "wrangler.toml");
const persistenceDirectory = mkdtempSync(path.join(tmpdir(), "scribe-drop-d1-"));
const upgradePersistenceDirectory = mkdtempSync(path.join(tmpdir(), "scribe-drop-d1-upgrade-"));
const hash = "a".repeat(64);

const requiredSchemaObjects = [
  "idx_attempt_winner_runpod",
  "idx_job_artifacts_job",
  "idx_job_attempts_job_created",
  "idx_job_attempts_id_job",
  "idx_job_attempts_status_updated",
  "idx_job_attempts_terminal",
  "idx_job_events_one_cancel_request_per_job",
  "idx_job_events_job_created",
  "idx_jobs_owner_created",
  "idx_jobs_owner_created_active",
  "idx_jobs_owner_status",
  "idx_jobs_status_updated",
  "idx_notification_outbox_pending",
  "idx_provider_executions_handle",
  "idx_provider_executions_provider_version",
  "idx_provider_executions_status_updated",
  "idx_runpod_submissions_attempt",
  "job_attempts",
  "job_artifacts",
  "job_events",
  "jobs",
  "notification_outbox",
  "provider_executions",
  "runpod_submissions",
  "trg_jobs_active_attempt_insert",
  "trg_jobs_active_attempt_update",
  "trg_attempt_execution_identity_immutable",
  "trg_attempt_cloud_run_cancellation_update",
  "trg_attempt_provider_execution_insert",
  "trg_attempt_provider_execution_update",
];

const requiredJobColumns = [
  "active_attempt_id",
  "deleted_at",
  "duration_seconds",
  "options_json",
  "source_etag",
  "status",
  "version",
];

const requiredAttemptColumns = [
  "claim_consumed_at",
  "claim_expires_at",
  "claim_issued_at",
  "claim_token_hash",
  "generation",
  "heartbeat_expires_at",
  "heartbeat_issued_at",
  "heartbeat_revoked_at",
  "heartbeat_token_hash",
  "media_duration_seconds",
  "execution_contract_version",
  "execution_options_json",
  "provider_kind",
  "provider_policy",
  "runpod_manifest_written",
  "runpod_output_error_code",
  "runpod_output_status",
  "runpod_terminal_job_id",
  "runpod_terminal_observed_at",
  "runpod_terminal_status",
  "segment_count",
  "status",
  "submission_finished_at",
  "submission_outcome",
  "winning_runpod_job_id",
];

const requiredNotificationColumns = ["job_id", "job_version", "status"];
const requiredProviderExecutionColumns = [
  "attempt_id",
  "cleanup_status",
  "create_outcome",
  "provider_handle",
  "provider_kind",
  "provider_policy",
  "provider_version",
  "status",
  "terminal_status",
  "version",
];

function runWrangler(args, expectFailure = false) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const failed = result.status !== 0;
  if (failed !== expectFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      expectFailure
        ? `Expected Wrangler command to fail: ${args.join(" ")}`
        : `Wrangler command failed: ${args.join(" ")}\n${output}`,
    );
  }

  return result.stdout;
}

function executeSql(sql) {
  return runWrangler([
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--local",
    "--config",
    orchestratorConfig,
    "--persist-to",
    persistenceDirectory,
    "--command",
    sql,
  ]);
}

function executeJson(sql) {
  return executeJsonAt(persistenceDirectory, sql);
}

function executeJsonAt(directory, sql) {
  const output = runWrangler([
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--local",
    "--config",
    orchestratorConfig,
    "--persist-to",
    directory,
    "--command",
    sql,
    "--json",
  ]);
  const batches = JSON.parse(output);
  const batch = Array.isArray(batches) ? batches[0] : undefined;

  if (batch?.success !== true || !Array.isArray(batch.results)) {
    throw new Error(`Unexpected Wrangler JSON response: ${output}`);
  }

  return batch.results;
}

function executeMigrationFile(directory, filename) {
  runWrangler([
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--local",
    "--config",
    orchestratorConfig,
    "--persist-to",
    directory,
    "--file",
    path.join(repositoryRoot, "migrations", filename),
  ]);
}

function expectSqlFailure(sql) {
  runWrangler(
    [
      "d1",
      "execute",
      "SCRIBE_DROP_DB",
      "--local",
      "--config",
      orchestratorConfig,
      "--persist-to",
      persistenceDirectory,
      "--command",
      `PRAGMA foreign_keys = ON; ${sql}`,
    ],
    true,
  );
}

function assertNames(rows, requiredNames, label) {
  const actualNames = new Set(rows.map((row) => row.name));
  const missingNames = requiredNames.filter((name) => !actualNames.has(name));

  if (missingNames.length > 0) {
    throw new Error(`${label} missing: ${missingNames.join(", ")}`);
  }
}

function insertJobSql(id, sourceKey, status = "CREATED") {
  return `
    INSERT INTO jobs (
      id,
      owner_sub,
      owner_email,
      title,
      original_filename,
      source_bucket,
      source_key,
      source_content_type,
      expected_size_bytes,
      status,
      options_json,
      created_at,
      updated_at
    ) VALUES (
      '${id}',
      'owner-sub',
      'owner@example.invalid',
      'Verification job',
      'recording.m4a',
      'recording-transcriber-staging',
      '${sourceKey}',
      'audio/mp4',
      1024,
      '${status}',
      '{"language":"ja"}',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z'
    );
  `;
}

try {
  runWrangler([
    "types",
    path.join(persistenceDirectory, "orchestrator-env.d.ts"),
    "--config",
    orchestratorConfig,
    "--env",
    "staging",
    "--include-runtime=false",
  ]);
  runWrangler([
    "types",
    path.join(persistenceDirectory, "web-env.d.ts"),
    "--config",
    webConfig,
    "--include-runtime=false",
  ]);

  const migrationArgs = [
    "d1",
    "migrations",
    "apply",
    "SCRIBE_DROP_DB",
    "--local",
    "--config",
    orchestratorConfig,
    "--persist-to",
    persistenceDirectory,
  ];
  runWrangler(migrationArgs);
  runWrangler(migrationArgs);

  const schemaRows = executeJson(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  assertNames(schemaRows, requiredSchemaObjects, "D1 schema objects");
  assertNames(executeJson("PRAGMA table_info(jobs)"), requiredJobColumns, "jobs columns");
  assertNames(
    executeJson("PRAGMA table_info(job_attempts)"),
    requiredAttemptColumns,
    "job_attempts columns",
  );
  assertNames(
    executeJson("PRAGMA table_info(notification_outbox)"),
    requiredNotificationColumns,
    "notification_outbox columns",
  );
  assertNames(
    executeJson("PRAGMA table_info(provider_executions)"),
    requiredProviderExecutionColumns,
    "provider_executions columns",
  );
  if (
    executeJson("PRAGMA table_info(job_attempts)").some(
      (column) => column.name === "webhook_token_hash",
    )
  ) {
    throw new Error("Unused webhook_token_hash column was not removed");
  }

  const activeAdmissionPlan = executeJson(`
    EXPLAIN QUERY PLAN
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = 'owner-sub'
      AND status IN (
        'CREATED',
        'UPLOADING',
        'UPLOADED',
        'SUBMISSION_PENDING',
        'SUBMITTING',
        'RUNNING',
        'CANCEL_REQUESTED'
      )
  `);
  if (
    !activeAdmissionPlan.some(
      (row) => typeof row.detail === "string" && row.detail.includes("idx_jobs_owner_status"),
    )
  ) {
    throw new Error(
      `Active admission query does not use idx_jobs_owner_status: ${JSON.stringify(
        activeAdmissionPlan,
      )}`,
    );
  }

  const rollingAdmissionPlan = executeJson(`
    EXPLAIN QUERY PLAN
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = 'owner-sub'
      AND created_at > '2026-07-25T00:00:00.000Z'
      AND created_at <= '2026-07-25T00:10:00.000Z'
  `);
  if (
    !rollingAdmissionPlan.some(
      (row) => typeof row.detail === "string" && row.detail.includes("idx_jobs_owner_created"),
    )
  ) {
    throw new Error(
      `Rolling admission query does not use idx_jobs_owner_created: ${JSON.stringify(
        rollingAdmissionPlan,
      )}`,
    );
  }

  const jobId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const attemptId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  executeSql(insertJobSql(jobId, `incoming/owner/${jobId}/nonce/source.m4a`));
  executeSql(`
    INSERT INTO job_attempts (
      id,
      job_id,
      generation,
      status,
      result_prefix,
      created_at,
      updated_at
    ) VALUES (
      '${attemptId}',
      '${jobId}',
      1,
      'SUBMISSION_PENDING',
      'results/owner/${jobId}/${attemptId}/',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z'
    );
    UPDATE jobs
    SET active_attempt_id = '${attemptId}'
    WHERE id = '${jobId}';
  `);

  const activeAttemptRows = executeJson(`SELECT active_attempt_id FROM jobs WHERE id = '${jobId}'`);
  if (activeAttemptRows[0]?.active_attempt_id !== attemptId) {
    throw new Error("D1 active attempt update was not persisted");
  }
  expectSqlFailure(`
    UPDATE job_attempts
    SET claim_token_hash = '${hash}'
    WHERE id = '${attemptId}';
  `);
  executeSql(`
    UPDATE job_attempts
    SET
      claim_token_hash = '${hash}',
      claim_issued_at = '2026-07-25T00:01:00.000Z',
      claim_expires_at = '2026-07-25T00:16:00.000Z'
    WHERE id = '${attemptId}';
  `);

  expectSqlFailure(
    insertJobSql(
      "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      "incoming/owner/invalid-status/nonce/source.m4a",
      "INVALID_STATUS",
    ),
  );
  expectSqlFailure(`
    INSERT INTO job_attempts (
      id,
      job_id,
      generation,
      status,
      result_prefix,
      created_at,
      updated_at
    ) VALUES (
      '01ARZ3NDEKTSV4RRFFQ69G5FAY',
      '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      1,
      'SUBMISSION_PENDING',
      'results/owner/orphan/',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z'
    );
  `);

  const secondJobId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  executeSql(insertJobSql(secondJobId, `incoming/owner/${secondJobId}/nonce/source.m4a`));
  expectSqlFailure(`
    UPDATE jobs
    SET active_attempt_id = '${attemptId}'
    WHERE id = '${secondJobId}';
  `);
  expectSqlFailure(`
    INSERT INTO job_attempts (
      id,
      job_id,
      generation,
      status,
      result_prefix,
      provider_kind,
      created_at,
      updated_at
    ) VALUES (
      '01ARZ3NDEKTSV4RRFFQ69G5FB4',
      '${secondJobId}',
      1,
      'SUBMISSION_PENDING',
      'results/owner/${secondJobId}/01ARZ3NDEKTSV4RRFFQ69G5FB4/',
      'runpod_serverless',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z'
    );
  `);

  const foreignKeyViolations = executeJson("PRAGMA foreign_key_check");
  if (foreignKeyViolations.length > 0) {
    throw new Error(`D1 foreign key violations: ${JSON.stringify(foreignKeyViolations)}`);
  }

  executeSql(`DELETE FROM jobs WHERE id = '${jobId}'`);
  const cascadedAttemptRows = executeJson(`SELECT id FROM job_attempts WHERE id = '${attemptId}'`);
  if (cascadedAttemptRows.length > 0) {
    throw new Error("D1 job deletion did not cascade to attempts");
  }

  const priorMigrationFiles = [
    "0001_initial.sql",
    "0002_job_admission_indexes.sql",
    "0003_attempt_capability_lifecycle.sql",
    "0004_runpod_claim_protocol.sql",
    "0005_reconciliation_completion.sql",
    "0006_phase6_failure_injection.sql",
    "0007_user_deletion.sql",
    "0008_retention_cleanup.sql",
  ];
  for (const filename of priorMigrationFiles) {
    executeMigrationFile(upgradePersistenceDirectory, filename);
  }
  const upgradeJobId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
  const upgradeOutboxId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
  const upgradeAttemptId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
  runWrangler([
    "d1",
    "execute",
    "SCRIBE_DROP_DB",
    "--local",
    "--config",
    orchestratorConfig,
    "--persist-to",
    upgradePersistenceDirectory,
    "--command",
    `
      ${insertJobSql(upgradeJobId, `incoming/owner/${upgradeJobId}/nonce/source.m4a`)}
      UPDATE jobs
      SET
        version = 3,
        status = 'FAILED',
        failed_at = '2026-07-25T00:03:00.000Z',
        updated_at = '2026-07-25T00:03:00.000Z'
      WHERE id = '${upgradeJobId}';
      INSERT INTO notification_outbox (
        id,
        job_id,
        status,
        attempt_count,
        next_attempt_at,
        created_at
      ) VALUES (
        '${upgradeOutboxId}',
        '${upgradeJobId}',
        'PENDING',
        2,
        '2026-07-25T00:04:00.000Z',
        '2026-07-25T00:03:00.000Z'
      );
      INSERT INTO job_attempts (
        id,
        job_id,
        generation,
        status,
        result_prefix,
        created_at,
        updated_at
      ) VALUES (
        '${upgradeAttemptId}',
        '${upgradeJobId}',
        1,
        'SUBMISSION_PENDING',
        'results/owner/${upgradeJobId}/${upgradeAttemptId}/',
        '2026-07-25T00:03:00.000Z',
        '2026-07-25T00:03:00.000Z'
      );
    `,
  ]);
  executeMigrationFile(upgradePersistenceDirectory, "0009_notification_terminal_generation.sql");
  executeMigrationFile(upgradePersistenceDirectory, "0010_provider_execution_compatibility.sql");
  const upgradedOutboxRows = executeJsonAt(
    upgradePersistenceDirectory,
    `SELECT job_version FROM notification_outbox WHERE id = '${upgradeOutboxId}'`,
  );
  if (upgradedOutboxRows[0]?.job_version !== 3) {
    throw new Error("D1 notification outbox job version was not backfilled during upgrade");
  }
  const upgradedExecutionRows = executeJsonAt(
    upgradePersistenceDirectory,
    `
      SELECT
        attempts.provider_kind,
        attempts.provider_policy,
        attempts.execution_contract_version,
        executions.id,
        executions.status
      FROM job_attempts AS attempts
      INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
      WHERE attempts.id = '${upgradeAttemptId}'
    `,
  );
  if (
    upgradedExecutionRows.length !== 1 ||
    upgradedExecutionRows[0]?.id !== upgradeAttemptId ||
    upgradedExecutionRows[0]?.provider_kind !== "runpod_serverless" ||
    upgradedExecutionRows[0]?.provider_policy !== "runpod_serverless_v1" ||
    upgradedExecutionRows[0]?.execution_contract_version !== 1 ||
    upgradedExecutionRows[0]?.status !== "PENDING"
  ) {
    throw new Error("D1 provider execution compatibility was not backfilled during upgrade");
  }

  console.log("D1 migration verification passed.");
} finally {
  rmSync(persistenceDirectory, { force: true, recursive: true });
  rmSync(upgradePersistenceDirectory, { force: true, recursive: true });
}
