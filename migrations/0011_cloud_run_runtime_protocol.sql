CREATE TABLE cloud_run_runtime_bootstraps (
    bootstrap_request_id TEXT PRIMARY KEY CHECK (length(bootstrap_request_id) = 26),
    execution_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 43
        AND request_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    execution_handle TEXT NOT NULL UNIQUE CHECK (
        length(execution_handle) = 43
        AND execution_handle NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    execution_name TEXT NOT NULL CHECK (
        length(execution_name) BETWEEN 1 AND 63
        AND execution_name NOT GLOB '*[^a-z0-9-]*'
    ),
    job_name TEXT NOT NULL CHECK (
        length(job_name) BETWEEN 1 AND 63
        AND job_name NOT GLOB '*[^a-z0-9-]*'
    ),
    public_key TEXT NOT NULL CHECK (
        length(public_key) = 43
        AND public_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    public_key_digest TEXT NOT NULL CHECK (
        length(public_key_digest) = 43
        AND public_key_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    challenge_id TEXT NOT NULL UNIQUE CHECK (length(challenge_id) = 26),
    challenge_hash TEXT NOT NULL CHECK (
        length(challenge_hash) = 43
        AND challenge_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    challenge_expires_at TEXT NOT NULL,
    session_id TEXT UNIQUE CHECK (session_id IS NULL OR length(session_id) = 26),
    session_token_hash TEXT CHECK (
        session_token_hash IS NULL
        OR (
            length(session_token_hash) = 43
            AND session_token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
        )
    ),
    session_issued_at TEXT,
    session_expires_at TEXT,
    claim_digest TEXT CHECK (
        claim_digest IS NULL
        OR (
            length(claim_digest) = 43
            AND claim_digest NOT GLOB '*[^A-Za-z0-9_-]*'
        )
    ),
    last_sequence INTEGER NOT NULL DEFAULT -1 CHECK (last_sequence >= -1),
    revoked_at TEXT,
    terminal_digest TEXT CHECK (
        terminal_digest IS NULL
        OR (
            length(terminal_digest) = 43
            AND terminal_digest NOT GLOB '*[^A-Za-z0-9_-]*'
        )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (
            session_id IS NULL
            AND session_token_hash IS NULL
            AND session_issued_at IS NULL
            AND session_expires_at IS NULL
            AND claim_digest IS NULL
            AND last_sequence = -1
        )
        OR (
            session_id IS NOT NULL
            AND session_token_hash IS NOT NULL
            AND session_issued_at IS NOT NULL
            AND session_expires_at IS NOT NULL
            AND claim_digest IS NOT NULL
        )
    ),
    CHECK (
        (revoked_at IS NULL AND terminal_digest IS NULL)
        OR (revoked_at IS NOT NULL AND terminal_digest IS NOT NULL)
    ),
    FOREIGN KEY(execution_id) REFERENCES provider_executions(id) ON DELETE CASCADE
);

CREATE INDEX idx_cloud_run_runtime_bootstraps_session
ON cloud_run_runtime_bootstraps(session_id)
WHERE session_id IS NOT NULL;

CREATE INDEX idx_cloud_run_runtime_bootstraps_expiry
ON cloud_run_runtime_bootstraps(challenge_expires_at, bootstrap_request_id)
WHERE claim_digest IS NULL;

CREATE TABLE cloud_run_runtime_events (
    bootstrap_request_id TEXT NOT NULL,
    session_id TEXT NOT NULL CHECK (length(session_id) = 26),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('ack', 'heartbeat', 'terminal')),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 43
        AND request_digest NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    progress TEXT CHECK (
        progress IS NULL OR progress IN ('bootstrap', 'download', 'transcribe', 'publish')
    ),
    terminal_status TEXT CHECK (
        terminal_status IS NULL OR terminal_status IN ('succeeded', 'failed', 'cancelled')
    ),
    terminal_error_code TEXT CHECK (
        terminal_error_code IS NULL OR terminal_error_code IN (
            'BOOTSTRAP_REJECTED',
            'SESSION_REJECTED',
            'SOURCE_DOWNLOAD_FAILED',
            'SOURCE_SIZE_MISMATCH',
            'SOURCE_ETAG_MISMATCH',
            'INVALID_MEDIA',
            'DURATION_LIMIT_EXCEEDED',
            'TRANSCRIPTION_FAILED',
            'ARTIFACT_UPLOAD_FAILED',
            'MANIFEST_UPLOAD_FAILED',
            'CANCELLED',
            'INTERNAL_ERROR'
        )
    ),
    artifact_count INTEGER CHECK (artifact_count IS NULL OR artifact_count BETWEEN 0 AND 3),
    duration_seconds REAL CHECK (
        duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 28800
    ),
    manifest_written INTEGER CHECK (manifest_written IS NULL OR manifest_written IN (0, 1)),
    segment_count INTEGER CHECK (
        segment_count IS NULL OR segment_count BETWEEN 0 AND 100000
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY(session_id, sequence),
    CHECK (
        (
            kind = 'ack'
            AND sequence = 0
            AND progress IS NULL
            AND terminal_status IS NULL
            AND terminal_error_code IS NULL
            AND artifact_count IS NULL
            AND duration_seconds IS NULL
            AND manifest_written IS NULL
            AND segment_count IS NULL
        )
        OR (
            kind = 'heartbeat'
            AND sequence > 0
            AND progress IS NOT NULL
            AND terminal_status IS NULL
            AND terminal_error_code IS NULL
            AND artifact_count IS NULL
            AND duration_seconds IS NULL
            AND manifest_written IS NULL
            AND segment_count IS NULL
        )
        OR (
            kind = 'terminal'
            AND progress IS NULL
            AND terminal_status IS NOT NULL
            AND artifact_count IS NOT NULL
            AND duration_seconds IS NOT NULL
            AND manifest_written IS NOT NULL
            AND segment_count IS NOT NULL
            AND (
                (
                    terminal_status = 'succeeded'
                    AND terminal_error_code IS NULL
                    AND artifact_count > 0
                    AND manifest_written = 1
                )
                OR (
                    terminal_status IN ('failed', 'cancelled')
                    AND terminal_error_code IS NOT NULL
                    AND manifest_written = 0
                )
            )
        )
    ),
    FOREIGN KEY(bootstrap_request_id)
        REFERENCES cloud_run_runtime_bootstraps(bootstrap_request_id) ON DELETE CASCADE
);

CREATE INDEX idx_cloud_run_runtime_events_bootstrap
ON cloud_run_runtime_events(bootstrap_request_id, sequence);

CREATE TRIGGER trg_cloud_run_runtime_event_advance
AFTER INSERT ON cloud_run_runtime_events
BEGIN
    UPDATE cloud_run_runtime_bootstraps
    SET
        last_sequence = NEW.sequence,
        revoked_at = CASE WHEN NEW.kind = 'terminal' THEN NEW.created_at ELSE revoked_at END,
        terminal_digest = CASE
            WHEN NEW.kind = 'terminal' THEN NEW.request_digest
            ELSE terminal_digest
        END,
        updated_at = NEW.created_at
    WHERE bootstrap_request_id = NEW.bootstrap_request_id
      AND session_id = NEW.session_id
      AND last_sequence = NEW.sequence - 1
      AND revoked_at IS NULL;

    SELECT RAISE(ABORT, 'runtime session sequence conflict')
    WHERE changes() != 1;
END;
