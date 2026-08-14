import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCloudRunRuntimeService } from "../src/cloud-run-runtime-composition.js";
import { createD1RuntimeFaultTargetRepository } from "../src/cloud-run-runtime-fault-service.js";
import { D1CloudRunRuntimeStore } from "../src/cloud-run-runtime-d1-store.js";
import { CloudRunTerminalFinalizer } from "../src/cloud-run-terminal-finalizer.js";
import { createD1NotificationOutboxRepository } from "../src/notification-outbox-repository.js";
import type {
  RuntimeAttemptContext,
  RuntimeBootstrapRecord,
} from "../src/cloud-run-runtime-store.js";

const NOW = "2026-08-11T00:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BOOTSTRAP_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const CHALLENGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const HANDLE = "h".repeat(43);
const OWNER_HASH = "a".repeat(32);
const NONCE = "n".repeat(22);
const OPTIONS = {
  contractVersion: 2 as const,
  language: "auto" as const,
  model: "large-v3-turbo" as const,
  outputFormats: ["markdown", "json", "srt"] as const,
  vad: true,
};
const STAGING_OPTIONS = { ...OPTIONS, language: "ja" as const };
const CLOUD_RUN_CONTROLLER_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const CLOUD_RUN_DERIVATION_SECRET = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

async function seedRuntimeContext(
  overrides: {
    readonly options?: typeof OPTIONS | typeof STAGING_OPTIONS;
    readonly sourceContentType?: string;
    readonly sourceEtag?: string;
    readonly sourceKey?: string;
    readonly sourceSizeBytes?: number;
  } = {},
): Promise<void> {
  const options = overrides.options ?? OPTIONS;
  const sourceContentType = overrides.sourceContentType ?? "audio/mp4";
  const sourceEtag = overrides.sourceEtag ?? "synthetic-etag";
  const sourceKey = overrides.sourceKey ?? `incoming/${OWNER_HASH}/${JOB_ID}/${NONCE}/source.m4a`;
  const sourceSizeBytes = overrides.sourceSizeBytes ?? 1024;
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO jobs (
        id, owner_sub, owner_email, title, original_filename, source_bucket, source_key,
        source_content_type, expected_size_bytes, actual_size_bytes, source_etag, status,
        options_json, created_at, updated_at
      ) VALUES (
        ?1, 'owner-sub', 'owner@example.invalid', 'Synthetic runtime', 'source.m4a',
        'recording-transcriber-test', ?2, ?3, ?4, ?4, ?5,
        'RUNNING', ?6, ?7, ?7
      )
    `,
  )
    .bind(
      JOB_ID,
      sourceKey,
      sourceContentType,
      sourceSizeBytes,
      sourceEtag,
      JSON.stringify(options),
      NOW,
    )
    .run();
  await env.SCRIBE_DROP_DB.prepare(
    `
      INSERT INTO job_attempts (
        id, job_id, generation, status, result_prefix, submission_outcome,
        provider_kind, provider_policy, execution_contract_version, execution_options_json,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, 1, 'RUNNING', ?3, 'accepted', 'cloud_run_jobs',
        'cloud_run_jobs_l4_v1', 2, ?4, ?5, ?5
      )
    `,
  )
    .bind(
      ATTEMPT_ID,
      JOB_ID,
      `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/`,
      JSON.stringify(options),
      NOW,
    )
    .run();
  await env.SCRIBE_DROP_DB.prepare(
    `
      UPDATE provider_executions
      SET provider_handle = ?2, provider_version = 1
      WHERE attempt_id = ?1
    `,
  )
    .bind(ATTEMPT_ID, HANDLE)
    .run();
  await env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1")
    .bind(JOB_ID, ATTEMPT_ID)
    .run();
}

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs;");
  await seedRuntimeContext();
});

describe("Cloud Run runtime composition", () => {
  const configuration = {
    APP_ENV: "staging",
    CLOUD_RUN_CONTROLLER_HMAC_PRIMARY: CLOUD_RUN_CONTROLLER_SECRET,
    CLOUD_RUN_CONTROLLER_ORIGIN:
      "https://scribe-drop-staging-gpu-controller-123456789012.asia-southeast1.run.app",
    CLOUD_RUN_ORCHESTRATOR_ORIGIN: "https://orchestrator-staging.example.invalid",
    CLOUD_RUN_RUNTIME_DERIVATION_SECRET: CLOUD_RUN_DERIVATION_SECRET,
    CLOUD_RUN_RUNTIME_MODE: "synthetic-shadow",
    CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    R2_SECRET_ACCESS_KEY: "0000000000000000",
  };

  it("injects all reviewed production ports only for the complete staging boundary", () => {
    expect(createCloudRunRuntimeService({ ...env, ...configuration })).toBeDefined();
    expect(
      createCloudRunRuntimeService({
        ...env,
        ...configuration,
        CLOUD_RUN_RUNTIME_DERIVATION_SECRET: `${CLOUD_RUN_DERIVATION_SECRET}=`,
      }),
    ).toBeUndefined();
    expect(
      createCloudRunRuntimeService({ ...env, ...configuration, APP_ENV: "production" }),
    ).toBeUndefined();
  });

  it("rejects a staging acceptance fault lease in production composition", () => {
    expect(() =>
      createCloudRunRuntimeService({
        ...env,
        ...configuration,
        APP_ENV: "production",
        STAGING_ACCEPTANCE_FAULT: "worker_disconnect_after_claim",
        STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: "2026-08-11T00:30:00.000Z",
        STAGING_ACCEPTANCE_FAULT_ISSUED_AT: "2026-08-11T00:00:00.000Z",
        STAGING_ACCEPTANCE_FAULT_JOB_ID: JOB_ID,
      }),
    ).toThrow("Staging acceptance fault configuration is invalid");
  });
});

describe("Cloud Run staging acceptance fault target", () => {
  it("resolves only the active Cloud Run attempt from the real D1 schema", async () => {
    const repository = createD1RuntimeFaultTargetRepository(env.SCRIBE_DROP_DB);
    await expect(repository.findJobId(HANDLE)).resolves.toBe(JOB_ID);
    await expect(repository.findJobId("z".repeat(43))).resolves.toBeUndefined();
  });
});

function store(): D1CloudRunRuntimeStore {
  return new D1CloudRunRuntimeStore(env.SCRIBE_DROP_DB, "staging");
}

function bootstrapRecord(overrides: Partial<RuntimeBootstrapRecord> = {}): RuntimeBootstrapRecord {
  return {
    bootstrapRequestId: BOOTSTRAP_ID,
    challengeExpiresAt: "2026-08-11T00:05:00.000Z",
    challengeHash: "c".repeat(43),
    challengeId: CHALLENGE_ID,
    claimDigest: null,
    executionHandle: HANDLE,
    executionName: "runtime-execution-1",
    jobName: "runtime-job-1",
    lastSequence: -1,
    publicKey: "p".repeat(43),
    publicKeyDigest: "d".repeat(43),
    requestDigest: "r".repeat(43),
    revokedAt: null,
    sessionExpiresAt: null,
    sessionId: null,
    sessionIssuedAt: null,
    sessionTokenHash: null,
    terminalDigest: null,
    ...overrides,
  };
}

async function context(repository: D1CloudRunRuntimeStore): Promise<RuntimeAttemptContext> {
  const selected = await repository.getAttempt(HANDLE);
  if (selected === null) throw new Error("missing synthetic runtime attempt");
  return selected;
}

async function begin(repository: D1CloudRunRuntimeStore): Promise<void> {
  const result = await repository.beginBootstrap({
    controllerVersion: 7,
    context: await context(repository),
    now: NOW,
    record: bootstrapRecord(),
  });
  expect(result.outcome).toBe("accepted");
}

async function claim(repository: D1CloudRunRuntimeStore): Promise<void> {
  await begin(repository);
  const result = await repository.consumeChallenge({
    bootstrapRequestId: BOOTSTRAP_ID,
    challengeId: CHALLENGE_ID,
    claimDigest: "q".repeat(43),
    executionHandle: HANDLE,
    now: "2026-08-11T00:01:00.000Z",
    sessionExpiresAt: "2026-08-11T00:10:00.000Z",
    sessionId: SESSION_ID,
    sessionIssuedAt: "2026-08-11T00:01:00.000Z",
    sessionTokenHash: "t".repeat(43),
  });
  expect(result.outcome).toBe("accepted");
}

describe("Cloud Run runtime D1 store", () => {
  it("verifies manifest v2 and atomically finalizes artifacts, job, outbox, and cleanup", async () => {
    const repository = store();
    await claim(repository);
    const common = {
      executionHandle: HANDLE,
      sessionId: SESSION_ID,
      sessionToken: "s".repeat(43),
    };
    await repository.applySessionEvent({
      digest: "1".repeat(43),
      event: { kind: "ack", request: { ...common, sequence: 0, state: "ready" } },
      now: "2026-08-11T00:02:00.000Z",
      tokenHash: "t".repeat(43),
    });
    const terminal = {
      artifactCount: 3,
      durationSeconds: 60,
      errorCode: null,
      executionHandle: HANDLE,
      manifestWritten: true,
      segmentCount: 4,
      sequence: 1,
      sessionId: SESSION_ID,
      sessionToken: "s".repeat(43),
      status: "succeeded" as const,
    };
    await repository.applySessionEvent({
      digest: "2".repeat(43),
      event: { kind: "terminal", request: terminal },
      now: "2026-08-11T00:03:00.000Z",
      tokenHash: "t".repeat(43),
    });
    const prefix = `results/${OWNER_HASH}/${JOB_ID}/${ATTEMPT_ID}/`;
    const objects = [
      { format: "markdown", key: `${prefix}transcript.md`, body: "markdown" },
      { format: "json", key: `${prefix}transcript.json`, body: "json" },
      { format: "srt", key: `${prefix}transcript.srt`, body: "srt" },
    ] as const;
    for (const object of objects) await env.RECORDINGS.put(object.key, object.body);
    const manifest = {
      artifacts: objects.map((object, index) => ({
        format: object.format,
        key: object.key,
        sha256: String(index + 1).repeat(64),
        sizeBytes: new TextEncoder().encode(object.body).byteLength,
      })),
      attemptId: ATTEMPT_ID,
      complete: true,
      executionContractVersion: 2,
      jobId: JOB_ID,
      requestedFormats: ["markdown", "json", "srt"],
      schemaVersion: 2,
    } as const;
    await env.RECORDINGS.put(`${prefix}manifest.json`, JSON.stringify(manifest));
    const finalizer = new CloudRunTerminalFinalizer(env.SCRIBE_DROP_DB, env.RECORDINGS, {
      createEventId: () => "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      createNotificationId: () => "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      now: () => new Date("2026-08-11T00:04:00.000Z"),
    });
    const selected = await repository.getAttempt(HANDLE);
    if (selected === null) throw new Error("missing terminal attempt");
    await expect(
      finalizer.finalize({ context: selected, request: terminal }),
    ).resolves.toBeUndefined();

    const row = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          attempts.status AS attempt_status,
          executions.status AS execution_status,
          executions.terminal_status,
          executions.cleanup_status,
          (SELECT COUNT(*) FROM job_artifacts WHERE attempt_id = ?1) AS artifact_count,
          (SELECT COUNT(*) FROM notification_outbox WHERE job_id = ?2) AS notification_count
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
        WHERE jobs.id = ?2
      `,
    )
      .bind(ATTEMPT_ID, JOB_ID)
      .first();
    expect(row).toEqual({
      artifact_count: 3,
      attempt_status: "COMPLETED",
      cleanup_status: "PENDING",
      execution_status: "TERMINAL",
      job_status: "COMPLETED",
      notification_count: 1,
      terminal_status: "COMPLETED",
    });
    await expect(
      repository.applySessionEvent({
        digest: "2".repeat(43),
        event: { kind: "terminal", request: terminal },
        now: "2026-08-11T00:05:00.000Z",
        tokenHash: "t".repeat(43),
      }),
    ).resolves.toMatchObject({
      context: { attemptId: ATTEMPT_ID, status: "TERMINAL_REPORTED" },
      outcome: "duplicate",
    });
    await expect(
      createD1NotificationOutboxRepository(env.SCRIBE_DROP_DB).claimNext(
        "2026-08-11T00:04:00.000Z",
        "2026-08-11T00:06:00.000Z",
      ),
    ).resolves.toMatchObject({
      durationSeconds: 60,
      jobId: JOB_ID,
      runpodExecutionMs: null,
      terminalStatus: "COMPLETED",
    });
  });

  it("atomically promotes a live controller execution before accepting bootstrap", async () => {
    await env.SCRIBE_DROP_DB.batch([
      env.SCRIBE_DROP_DB.prepare(
        "UPDATE provider_executions SET status = 'CREATING', create_outcome = NULL WHERE attempt_id = ?1",
      ).bind(ATTEMPT_ID),
      env.SCRIBE_DROP_DB.prepare(
        "UPDATE job_attempts SET status = 'SUBMITTING', submission_outcome = NULL WHERE id = ?1",
      ).bind(ATTEMPT_ID),
      env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET status = 'SUBMITTING' WHERE id = ?1").bind(
        JOB_ID,
      ),
    ]);
    const repository = store();
    const selected = await context(repository);
    await expect(
      repository.beginBootstrap({
        controllerVersion: 7,
        context: selected,
        now: NOW,
        record: bootstrapRecord(),
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    const row = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          jobs.status AS job_status,
          attempts.status AS attempt_status,
          executions.status AS execution_status,
          executions.create_outcome
        FROM jobs
        INNER JOIN job_attempts AS attempts ON attempts.id = jobs.active_attempt_id
        INNER JOIN provider_executions AS executions ON executions.attempt_id = attempts.id
        WHERE jobs.id = ?1
      `,
    )
      .bind(JOB_ID)
      .first();
    expect(row).toEqual({
      attempt_status: "RUNNING",
      create_outcome: "accepted",
      execution_status: "RUNNING",
      job_status: "RUNNING",
    });
  });

  it("loads the exact staging speech fixture row shape", async () => {
    const sourceKey = `incoming/${OWNER_HASH}/${JOB_ID}/-R11Ugfp9MqCogQ0ts4R6Q/source.wav`;
    await env.SCRIBE_DROP_DB.exec("DELETE FROM jobs;");
    await seedRuntimeContext({
      options: STAGING_OPTIONS,
      sourceContentType: "audio/wav",
      sourceEtag: "e3509457b255603cf39afd39f3281d46",
      sourceKey,
      sourceSizeBytes: 30_720_044,
    });
    await expect(store().getAttempt(HANDLE)).resolves.toMatchObject({
      options: STAGING_OPTIONS,
      sourceEtag: "e3509457b255603cf39afd39f3281d46",
      sourceKey,
      sourceSizeBytes: 30_720_044,
      status: "PENDING_BOOTSTRAP",
    });
  });

  it("loads only an exact active provider binding and converges bootstrap replay", async () => {
    const repository = store();
    await expect(repository.getAttempt(HANDLE)).resolves.toMatchObject({
      attemptId: ATTEMPT_ID,
      cancelRequested: false,
      environment: "staging",
      jobId: JOB_ID,
      ownerHash: OWNER_HASH,
      status: "PENDING_BOOTSTRAP",
    });
    const selected = await context(repository);
    await expect(
      repository.beginBootstrap({
        controllerVersion: 7,
        context: selected,
        now: NOW,
        record: bootstrapRecord(),
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    await expect(
      repository.beginBootstrap({
        controllerVersion: 7,
        context: selected,
        now: NOW,
        record: bootstrapRecord(),
      }),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(
      repository.beginBootstrap({
        controllerVersion: 7,
        context: selected,
        now: NOW,
        record: bootstrapRecord({ requestDigest: "x".repeat(43) }),
      }),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("consumes a challenge once and returns the persisted session for an exact retry", async () => {
    const repository = store();
    await begin(repository);
    const request = {
      bootstrapRequestId: BOOTSTRAP_ID,
      challengeId: CHALLENGE_ID,
      claimDigest: "q".repeat(43),
      executionHandle: HANDLE,
      now: "2026-08-11T00:01:00.000Z",
      sessionExpiresAt: "2026-08-11T00:10:00.000Z",
      sessionId: SESSION_ID,
      sessionIssuedAt: "2026-08-11T00:01:00.000Z",
      sessionTokenHash: "t".repeat(43),
    };
    await expect(repository.consumeChallenge(request)).resolves.toMatchObject({
      outcome: "accepted",
      record: { sessionId: SESSION_ID },
    });
    await expect(
      repository.consumeChallenge({
        ...request,
        sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      }),
    ).resolves.toMatchObject({
      outcome: "duplicate",
      record: { sessionId: SESSION_ID },
    });
    await expect(
      repository.consumeChallenge({ ...request, claimDigest: "z".repeat(43) }),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("serializes ack, heartbeat, terminal and preserves exact terminal replay", async () => {
    const repository = store();
    await claim(repository);
    const common = {
      executionHandle: HANDLE,
      sessionId: SESSION_ID,
      sessionToken: "s".repeat(43),
    };
    const apply = (
      event: Parameters<D1CloudRunRuntimeStore["applySessionEvent"]>[0],
    ): Promise<ApplyResult> => repository.applySessionEvent(event);
    await expect(
      apply({
        digest: "0".repeat(43),
        event: {
          kind: "heartbeat",
          request: { ...common, progress: "bootstrap", sequence: 0 },
        },
        now: "2026-08-11T00:02:00.000Z",
        tokenHash: "t".repeat(43),
      }),
    ).resolves.toEqual({ outcome: "stale" });
    await expect(
      apply({
        digest: "1".repeat(43),
        event: { kind: "ack", request: { ...common, sequence: 0, state: "ready" } },
        now: "2026-08-11T00:02:00.000Z",
        tokenHash: "t".repeat(43),
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });

    const heartbeat = {
      digest: "2".repeat(43),
      event: {
        kind: "heartbeat" as const,
        request: { ...common, progress: "download" as const, sequence: 1 },
      },
      now: "2026-08-11T00:03:00.000Z",
      tokenHash: "t".repeat(43),
    };
    await expect(Promise.all([apply(heartbeat), apply(heartbeat)])).resolves.toSatisfy(
      (results: ApplyResult[]) =>
        results
          .map(({ outcome }) => outcome)
          .toSorted()
          .join(",") === "accepted,duplicate",
    );

    const terminal = {
      digest: "3".repeat(43),
      event: {
        kind: "terminal" as const,
        request: {
          ...common,
          artifactCount: 3,
          durationSeconds: 12.5,
          errorCode: null,
          manifestWritten: true,
          segmentCount: 4,
          sequence: 2,
          status: "succeeded" as const,
        },
      },
      now: "2026-08-11T00:04:00.000Z",
      tokenHash: "t".repeat(43),
    };
    await expect(apply(terminal)).resolves.toMatchObject({
      context: { status: "TERMINAL_REPORTED" },
      outcome: "accepted",
    });
    await expect(apply(terminal)).resolves.toMatchObject({ outcome: "duplicate" });
    const persisted = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT artifact_count, duration_seconds, manifest_written, segment_count, terminal_status
        FROM cloud_run_runtime_events
        WHERE session_id = ?1 AND sequence = 2
      `,
    )
      .bind(SESSION_ID)
      .first();
    expect(persisted).toEqual({
      artifact_count: 3,
      duration_seconds: 12.5,
      manifest_written: 1,
      segment_count: 4,
      terminal_status: "succeeded",
    });
  });

  it("allows a failure terminal at sequence zero but never a heartbeat before ack", async () => {
    const repository = store();
    await claim(repository);
    const terminal = {
      digest: "f".repeat(43),
      event: {
        kind: "terminal" as const,
        request: {
          artifactCount: 0,
          durationSeconds: 0,
          errorCode: "INTERNAL_ERROR" as const,
          executionHandle: HANDLE,
          manifestWritten: false,
          segmentCount: 0,
          sequence: 0,
          sessionId: SESSION_ID,
          sessionToken: "s".repeat(43),
          status: "failed" as const,
        },
      },
      now: "2026-08-11T00:02:00.000Z",
      tokenHash: "t".repeat(43),
    };
    await expect(repository.applySessionEvent(terminal)).resolves.toMatchObject({
      context: { status: "TERMINAL_REPORTED" },
      outcome: "accepted",
    });
  });

  it("fails closed when the source/result ownership binding drifts", async () => {
    await env.SCRIBE_DROP_DB.prepare("UPDATE job_attempts SET result_prefix = ?2 WHERE id = ?1")
      .bind(ATTEMPT_ID, `results/${"b".repeat(32)}/${JOB_ID}/${ATTEMPT_ID}/`)
      .run();
    await expect(store().getAttempt(HANDLE)).rejects.toThrow(
      "Cloud Run runtime attempt compatibility check failed",
    );
  });
});

type ApplyResult = Awaited<ReturnType<D1CloudRunRuntimeStore["applySessionEvent"]>>;
