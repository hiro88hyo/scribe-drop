import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runpodClaimResponseSchema } from "@scribe-drop/contracts";

import { hashCapabilityToken } from "../src/capability-token.js";
import { createD1RunpodControlRepository } from "../src/runpod-control-repository.js";

const NOW = "2026-07-25T00:00:00.000Z";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SECOND_JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const SECOND_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const FIRST_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const SECOND_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const CLAIM_TOKEN = "c".repeat(43);

beforeAll(async () => {
  await applyD1Migrations(env.SCRIBE_DROP_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.SCRIBE_DROP_DB.exec(`
    DELETE FROM notification_outbox;
    DELETE FROM job_events;
    DELETE FROM runpod_submissions;
    DELETE FROM jobs;
  `);
});

async function seedPendingJob(jobId: string, attemptId: string): Promise<void> {
  await env.SCRIBE_DROP_DB.batch([
    env.SCRIBE_DROP_DB.prepare(
      `
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
          actual_size_bytes,
          source_etag,
          status,
          options_json,
          active_attempt_id,
          created_at,
          uploaded_at,
          updated_at
        ) VALUES (
          ?1,
          'owner-sub',
          'owner@example.invalid',
          'Verification job',
          'recording.m4a',
          'recording-transcriber-test',
          ?2,
          'audio/mp4',
          1024,
          1024,
          'etag',
          'SUBMISSION_PENDING',
          '{"language":"ja"}',
          NULL,
          ?3,
          ?3,
          ?3
        )
      `,
    ).bind(jobId, `incoming/owner/${jobId}/nonce/source.m4a`, NOW),
    env.SCRIBE_DROP_DB.prepare(
      `
        INSERT INTO job_attempts (
          id,
          job_id,
          generation,
          status,
          result_prefix,
          created_at,
          updated_at
        ) VALUES (?1, ?2, 1, 'SUBMISSION_PENDING', ?3, ?4, ?4)
      `,
    ).bind(attemptId, jobId, `results/owner/${jobId}/${attemptId}/`, NOW),
    env.SCRIBE_DROP_DB.prepare("UPDATE jobs SET active_attempt_id = ?2 WHERE id = ?1").bind(
      jobId,
      attemptId,
    ),
  ]);
}

describe("D1 RunPod control repository", () => {
  beforeEach(async () => {
    await seedPendingJob(JOB_ID, ATTEMPT_ID);
    await seedPendingJob(SECOND_JOB_ID, SECOND_ATTEMPT_ID);
  });

  it("issues one claim under the environment-wide submission gate", async () => {
    const repository = createD1RunpodControlRepository(env.SCRIBE_DROP_DB);
    const hash = await hashCapabilityToken(CLAIM_TOKEN);

    await expect(
      repository.prepareSubmission({
        claimExpiresAt: "2026-07-25T00:15:00.000Z",
        claimTokenHash: hash,
        jobId: JOB_ID,
        timestamp: NOW,
      }),
    ).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      generation: 1,
      jobId: JOB_ID,
    });
    await expect(
      repository.prepareSubmission({
        claimExpiresAt: "2026-07-25T00:15:00.000Z",
        claimTokenHash: hash,
        jobId: SECOND_JOB_ID,
        timestamp: NOW,
      }),
    ).resolves.toBeUndefined();

    const attempts = await env.SCRIBE_DROP_DB.prepare(
      "SELECT id, status, claim_token_hash FROM job_attempts ORDER BY id",
    ).all();
    expect(attempts.results).toEqual([
      {
        claim_token_hash: hash,
        id: ATTEMPT_ID,
        status: "SUBMITTING",
      },
      {
        claim_token_hash: null,
        id: SECOND_ATTEMPT_ID,
        status: "SUBMISSION_PENDING",
      },
    ]);
  });

  it("allows exactly one concurrent winner and records every RunPod job ID", async () => {
    const repository = createD1RunpodControlRepository(env.SCRIBE_DROP_DB);
    const claimHash = await hashCapabilityToken(CLAIM_TOKEN);
    const heartbeatHash = await hashCapabilityToken("h".repeat(43));
    await repository.prepareSubmission({
      claimExpiresAt: "2026-07-25T00:15:00.000Z",
      claimTokenHash: claimHash,
      jobId: JOB_ID,
      timestamp: NOW,
    });

    const outcomes = await Promise.all([
      repository.claimWinner({
        attemptId: ATTEMPT_ID,
        claimTokenHash: claimHash,
        eventId: FIRST_EVENT_ID,
        heartbeatExpiresAt: "2026-07-25T08:00:00.000Z",
        heartbeatTokenHash: heartbeatHash,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-a",
        timestamp: NOW,
      }),
      repository.claimWinner({
        attemptId: ATTEMPT_ID,
        claimTokenHash: claimHash,
        eventId: SECOND_EVENT_ID,
        heartbeatExpiresAt: "2026-07-25T08:00:00.000Z",
        heartbeatTokenHash: heartbeatHash,
        jobId: JOB_ID,
        runpodJobId: "runpod-job-b",
        timestamp: NOW,
      }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const attempt = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT
          claim_consumed_at,
          status,
          winning_runpod_job_id
        FROM job_attempts
        WHERE id = ?1
      `,
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(attempt).toMatchObject({
      claim_consumed_at: NOW,
      status: "RUNNING",
    });
    expect(["runpod-job-a", "runpod-job-b"]).toContain(attempt?.["winning_runpod_job_id"]);

    const submissions = await env.SCRIBE_DROP_DB.prepare(
      `
        SELECT runpod_job_id, is_winner
        FROM runpod_submissions
        WHERE attempt_id = ?1
        ORDER BY runpod_job_id
      `,
    )
      .bind(ATTEMPT_ID)
      .all();
    expect(submissions.results).toEqual([
      {
        is_winner: attempt?.["winning_runpod_job_id"] === "runpod-job-a" ? 1 : 0,
        runpod_job_id: "runpod-job-a",
      },
      {
        is_winner: attempt?.["winning_runpod_job_id"] === "runpod-job-b" ? 1 : 0,
        runpod_job_id: "runpod-job-b",
      },
    ]);
    const events = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'runpod_claim_granted'",
    ).first<{ count: number }>();
    expect(events?.count).toBe(1);
  });

  it("serves claim, replay rejection, loser deduplication, and heartbeat end to end", async () => {
    const repository = createD1RunpodControlRepository(env.SCRIBE_DROP_DB);
    await repository.prepareSubmission({
      claimExpiresAt: "2027-01-01T00:15:00.000Z",
      claimTokenHash: await hashCapabilityToken(CLAIM_TOKEN),
      jobId: JOB_ID,
      timestamp: NOW,
    });
    const claimBody = {
      attemptId: ATTEMPT_ID,
      claimToken: CLAIM_TOKEN,
      jobId: JOB_ID,
      runpodJobId: "winner-job-id",
    };

    const claimResponse = await exports.default.fetch(
      new Request("https://orchestrator.example.invalid/internal/runpod/claim", {
        body: JSON.stringify(claimBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(claimResponse.status).toBe(200);
    const claim = runpodClaimResponseSchema.parse(await claimResponse.json());
    expect(claim).toMatchObject({
      granted: true,
      source: {
        expectedEtag: "etag",
        expectedSizeBytes: 1024,
      },
    });
    if (!("granted" in claim)) {
      throw new Error("Expected a granted claim");
    }

    const replayResponse = await exports.default.fetch(
      new Request("https://orchestrator.example.invalid/internal/runpod/claim", {
        body: JSON.stringify(claimBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(replayResponse.status).toBe(403);

    const loserResponse = await exports.default.fetch(
      new Request("https://orchestrator.example.invalid/internal/runpod/claim", {
        body: JSON.stringify({
          ...claimBody,
          runpodJobId: "loser-job-id",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(loserResponse.status).toBe(200);
    await expect(loserResponse.json()).resolves.toEqual({ deduplicated: true });

    const heartbeatResponse = await exports.default.fetch(
      new Request("https://orchestrator.example.invalid/internal/runpod/heartbeat", {
        body: JSON.stringify({
          attemptId: ATTEMPT_ID,
          heartbeatToken: claim.heartbeat.token,
          jobId: JOB_ID,
          runpodJobId: "winner-job-id",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(heartbeatResponse.status).toBe(200);
    await expect(heartbeatResponse.json()).resolves.toEqual({
      cancelRequested: false,
    });

    const submissionCount = await env.SCRIBE_DROP_DB.prepare(
      "SELECT COUNT(*) AS count FROM runpod_submissions WHERE attempt_id = ?1",
    )
      .bind(ATTEMPT_ID)
      .first<{ count: number }>();
    expect(submissionCount?.count).toBe(2);
  });

  it("distinguishes accepted, unknown, and rejected submission outcomes", async () => {
    const repository = createD1RunpodControlRepository(env.SCRIBE_DROP_DB);
    const claimHash = await hashCapabilityToken(CLAIM_TOKEN);
    await repository.prepareSubmission({
      claimExpiresAt: "2026-07-25T00:15:00.000Z",
      claimTokenHash: claimHash,
      jobId: JOB_ID,
      timestamp: NOW,
    });

    await expect(
      repository.recordSubmissionAccepted({
        attemptId: ATTEMPT_ID,
        runpodJobId: "accepted-job",
        timestamp: "2026-07-25T00:00:01.000Z",
      }),
    ).resolves.toBe(true);
    const accepted = await env.SCRIBE_DROP_DB.prepare(
      "SELECT submission_outcome FROM job_attempts WHERE id = ?1",
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(accepted?.["submission_outcome"]).toBe("accepted");

    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE job_attempts SET submission_outcome = NULL WHERE id = ?1",
    )
      .bind(ATTEMPT_ID)
      .run();
    await expect(
      repository.recordSubmissionUnknown(ATTEMPT_ID, "2026-07-25T00:00:02.000Z"),
    ).resolves.toBe(true);

    await env.SCRIBE_DROP_DB.prepare(
      "UPDATE job_attempts SET submission_outcome = NULL WHERE id = ?1",
    )
      .bind(ATTEMPT_ID)
      .run();
    await expect(
      repository.recordSubmissionRejected({
        attemptId: ATTEMPT_ID,
        eventId: FIRST_EVENT_ID,
        jobId: JOB_ID,
        timestamp: "2026-07-25T00:00:03.000Z",
      }),
    ).resolves.toBe(true);
    const rejected = await env.SCRIBE_DROP_DB.prepare(
      "SELECT status, submission_outcome FROM job_attempts WHERE id = ?1",
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(rejected).toEqual({
      status: "FAILED",
      submission_outcome: "rejected",
    });
  });
});
