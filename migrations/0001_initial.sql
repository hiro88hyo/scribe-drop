PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY CHECK (length(id) = 26),
    owner_sub TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),

    source_bucket TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE CHECK (source_key LIKE 'incoming/%'),
    source_content_type TEXT NOT NULL,
    expected_size_bytes INTEGER NOT NULL
        CHECK (expected_size_bytes BETWEEN 1 AND 2147483648),
    actual_size_bytes INTEGER
        CHECK (actual_size_bytes IS NULL OR actual_size_bytes BETWEEN 1 AND 2147483648),
    source_etag TEXT CHECK (source_etag IS NULL OR length(source_etag) > 0),
    duration_seconds REAL
        CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 28800),

    status TEXT NOT NULL CHECK (
        status IN (
            'CREATED',
            'UPLOADING',
            'UPLOADED',
            'SUBMISSION_PENDING',
            'SUBMITTING',
            'RUNNING',
            'CANCEL_REQUESTED',
            'COMPLETED',
            'FAILED',
            'CANCELLED',
            'EXPIRED',
            'SOURCE_MUTATED'
        )
    ),
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),

    active_attempt_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),

    error_code TEXT,
    error_message TEXT,

    upload_expires_at TEXT,
    created_at TEXT NOT NULL,
    uploaded_at TEXT,
    processing_started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    cancelled_at TEXT,
    notified_at TEXT,
    deleted_at TEXT,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(active_attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE INDEX idx_jobs_owner_created
ON jobs(owner_sub, created_at DESC, id DESC);

CREATE INDEX idx_jobs_owner_created_active
ON jobs(owner_sub, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX idx_jobs_status_updated
ON jobs(status, updated_at);

CREATE TABLE job_attempts (
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
    claim_token_hash TEXT NOT NULL CHECK (
        length(claim_token_hash) = 64
        AND claim_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    heartbeat_token_hash TEXT NOT NULL CHECK (
        length(heartbeat_token_hash) = 64
        AND heartbeat_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    webhook_token_hash TEXT NOT NULL CHECK (
        length(webhook_token_hash) = 64
        AND webhook_token_hash NOT GLOB '*[^0-9a-f]*'
    ),

    winning_runpod_job_id TEXT,
    result_prefix TEXT NOT NULL CHECK (result_prefix LIKE 'results/%'),

    submission_started_at TEXT,
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

    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE(job_id, generation)
);

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

CREATE TABLE runpod_submissions (
    runpod_job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    is_winner INTEGER NOT NULL DEFAULT 0 CHECK (is_winner IN (0, 1)),
    source TEXT NOT NULL CHECK (
        source IN ('submit_response', 'worker_claim', 'webhook', 'status_poll')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE
);

CREATE INDEX idx_runpod_submissions_attempt
ON runpod_submissions(attempt_id);

CREATE TABLE job_events (
    id TEXT PRIMARY KEY CHECK (length(id) = 26),
    job_id TEXT NOT NULL,
    attempt_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    created_at TEXT NOT NULL,

    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id) REFERENCES job_attempts(id) ON DELETE SET NULL
);

CREATE INDEX idx_job_events_job_created
ON job_events(job_id, created_at);

CREATE TABLE notification_outbox (
    id TEXT PRIMARY KEY CHECK (length(id) = 26),
    job_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,

    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_outbox_pending
ON notification_outbox(status, next_attempt_at);
