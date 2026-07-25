PRAGMA foreign_keys = OFF;

DROP TRIGGER trg_jobs_active_attempt_insert;
DROP TRIGGER trg_jobs_active_attempt_update;

CREATE TABLE job_attempts_phase4 (
    id TEXT PRIMARY KEY CHECK (length(id) = 26),
    job_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),

    status TEXT NOT NULL CHECK (
        status IN (
            'SUBMISSION_PENDING',
            'SUBMITTING',
            'RUNNING',
            'CANCEL_REQUESTED',
            'COMPLETED',
            'FAILED',
            'CANCELLED'
        )
    ),
    claim_token_hash TEXT CHECK (
        claim_token_hash IS NULL
        OR (
            length(claim_token_hash) = 64
            AND claim_token_hash NOT GLOB '*[^0-9a-f]*'
        )
    ),
    claim_issued_at TEXT,
    claim_expires_at TEXT,
    claim_consumed_at TEXT,
    heartbeat_token_hash TEXT CHECK (
        heartbeat_token_hash IS NULL
        OR (
            length(heartbeat_token_hash) = 64
            AND heartbeat_token_hash NOT GLOB '*[^0-9a-f]*'
        )
    ),
    heartbeat_issued_at TEXT,
    heartbeat_expires_at TEXT,
    heartbeat_revoked_at TEXT,

    winning_runpod_job_id TEXT,
    result_prefix TEXT NOT NULL CHECK (result_prefix LIKE 'results/%'),

    submission_started_at TEXT,
    submission_outcome TEXT CHECK (
        submission_outcome IS NULL
        OR submission_outcome IN ('accepted', 'rejected', 'unknown')
    ),
    submission_finished_at TEXT,
    claimed_at TEXT,
    heartbeat_at TEXT,
    completed_at TEXT,
    failed_at TEXT,

    runpod_delay_ms INTEGER CHECK (runpod_delay_ms IS NULL OR runpod_delay_ms >= 0),
    runpod_execution_ms INTEGER CHECK (
        runpod_execution_ms IS NULL OR runpod_execution_ms >= 0
    ),

    error_code TEXT,
    error_message TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    CHECK (
        (
            claim_token_hash IS NULL
            AND claim_issued_at IS NULL
            AND claim_expires_at IS NULL
            AND claim_consumed_at IS NULL
        )
        OR (
            claim_token_hash IS NOT NULL
            AND claim_issued_at IS NOT NULL
            AND claim_expires_at IS NOT NULL
        )
    ),
    CHECK (
        (
            heartbeat_token_hash IS NULL
            AND heartbeat_issued_at IS NULL
            AND heartbeat_expires_at IS NULL
            AND heartbeat_revoked_at IS NULL
        )
        OR (
            heartbeat_token_hash IS NOT NULL
            AND heartbeat_issued_at IS NOT NULL
            AND heartbeat_expires_at IS NOT NULL
        )
    ),

    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE(job_id, generation)
);

INSERT INTO job_attempts_phase4 (
    id,
    job_id,
    generation,
    status,
    claim_token_hash,
    claim_issued_at,
    claim_expires_at,
    claim_consumed_at,
    heartbeat_token_hash,
    heartbeat_issued_at,
    heartbeat_expires_at,
    heartbeat_revoked_at,
    winning_runpod_job_id,
    result_prefix,
    submission_started_at,
    submission_outcome,
    submission_finished_at,
    claimed_at,
    heartbeat_at,
    completed_at,
    failed_at,
    runpod_delay_ms,
    runpod_execution_ms,
    error_code,
    error_message,
    created_at,
    updated_at
)
SELECT
    id,
    job_id,
    generation,
    status,
    CASE WHEN claim_issued_at IS NULL THEN NULL ELSE claim_token_hash END,
    claim_issued_at,
    claim_expires_at,
    claim_consumed_at,
    CASE WHEN heartbeat_issued_at IS NULL THEN NULL ELSE heartbeat_token_hash END,
    heartbeat_issued_at,
    NULL,
    NULL,
    winning_runpod_job_id,
    result_prefix,
    submission_started_at,
    NULL,
    NULL,
    claimed_at,
    heartbeat_at,
    completed_at,
    failed_at,
    runpod_delay_ms,
    runpod_execution_ms,
    error_code,
    error_message,
    created_at,
    updated_at
FROM job_attempts;

DROP TABLE job_attempts;
ALTER TABLE job_attempts_phase4 RENAME TO job_attempts;

CREATE INDEX idx_job_attempts_job_created
ON job_attempts(job_id, created_at DESC);

CREATE INDEX idx_job_attempts_status_updated
ON job_attempts(status, updated_at);

CREATE UNIQUE INDEX idx_attempt_winner_runpod
ON job_attempts(winning_runpod_job_id)
WHERE winning_runpod_job_id IS NOT NULL;

CREATE TRIGGER trg_jobs_active_attempt_insert
BEFORE INSERT ON jobs
WHEN NEW.active_attempt_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'active attempt must belong to job')
    WHERE NOT EXISTS (
        SELECT 1
        FROM job_attempts
        WHERE id = NEW.active_attempt_id
          AND job_id = NEW.id
    );
END;

CREATE TRIGGER trg_jobs_active_attempt_update
BEFORE UPDATE OF active_attempt_id ON jobs
WHEN NEW.active_attempt_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'active attempt must belong to job')
    WHERE NOT EXISTS (
        SELECT 1
        FROM job_attempts
        WHERE id = NEW.active_attempt_id
          AND job_id = NEW.id
    );
END;

PRAGMA foreign_keys = ON;
