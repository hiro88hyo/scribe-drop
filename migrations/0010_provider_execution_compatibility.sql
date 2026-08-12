ALTER TABLE job_attempts ADD COLUMN provider_kind TEXT CHECK (
    provider_kind IS NULL
    OR (
        length(provider_kind) BETWEEN 1 AND 64
        AND provider_kind NOT GLOB '*[^a-z0-9_]*'
    )
);

ALTER TABLE job_attempts ADD COLUMN provider_policy TEXT CHECK (
    provider_policy IS NULL
    OR (
        length(provider_policy) BETWEEN 1 AND 96
        AND provider_policy NOT GLOB '*[^a-z0-9_]*'
    )
);

ALTER TABLE job_attempts ADD COLUMN execution_contract_version INTEGER CHECK (
    execution_contract_version IS NULL OR execution_contract_version IN (1, 2)
);

ALTER TABLE job_attempts ADD COLUMN execution_options_json TEXT CHECK (
    (
        execution_options_json IS NULL
        AND provider_kind IS NULL
        AND provider_policy IS NULL
        AND execution_contract_version IS NULL
    )
    OR (
        execution_options_json IS NOT NULL
        AND provider_kind IS NOT NULL
        AND provider_policy IS NOT NULL
        AND execution_contract_version IS NOT NULL
        AND json_valid(execution_options_json)
    )
);

UPDATE job_attempts
SET
    provider_kind = 'runpod_serverless',
    provider_policy = 'runpod_serverless_v1',
    execution_contract_version = 1,
    execution_options_json = (
        SELECT json_patch(
            '{"contractVersion":1,"language":"auto","model":"large-v3-turbo","outputFormats":["markdown","json","srt"],"vad":true}',
            jobs.options_json
        )
        FROM jobs
        WHERE jobs.id = job_attempts.job_id
    );

CREATE TABLE provider_executions (
    id TEXT PRIMARY KEY CHECK (length(id) = 26),
    attempt_id TEXT NOT NULL UNIQUE,
    provider_kind TEXT NOT NULL CHECK (
        length(provider_kind) BETWEEN 1 AND 64
        AND provider_kind NOT GLOB '*[^a-z0-9_]*'
    ),
    provider_policy TEXT NOT NULL CHECK (
        length(provider_policy) BETWEEN 1 AND 96
        AND provider_policy NOT GLOB '*[^a-z0-9_]*'
    ),
    status TEXT NOT NULL CHECK (
        status IN (
            'PENDING',
            'CREATING',
            'RUNNING',
            'CANCEL_REQUESTED',
            'TERMINAL'
        )
    ),
    create_outcome TEXT CHECK (
        create_outcome IS NULL OR create_outcome IN ('accepted', 'rejected', 'unknown')
    ),
    provider_handle TEXT CHECK (
        provider_handle IS NULL OR length(provider_handle) BETWEEN 1 AND 256
    ),
    terminal_status TEXT CHECK (
        terminal_status IS NULL
        OR terminal_status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
    ),
    cleanup_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (
        cleanup_status IN ('NOT_REQUESTED', 'PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_executions_status_updated
ON provider_executions(status, updated_at, id);

CREATE UNIQUE INDEX idx_provider_executions_handle
ON provider_executions(provider_kind, provider_handle)
WHERE provider_handle IS NOT NULL;

INSERT INTO provider_executions (
    id,
    attempt_id,
    provider_kind,
    provider_policy,
    status,
    create_outcome,
    provider_handle,
    terminal_status,
    created_at,
    updated_at
)
SELECT
    id,
    id,
    provider_kind,
    provider_policy,
    CASE status
        WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
        WHEN 'SUBMITTING' THEN 'CREATING'
        WHEN 'RUNNING' THEN 'RUNNING'
        WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
        ELSE 'TERMINAL'
    END,
    submission_outcome,
    winning_runpod_job_id,
    runpod_terminal_status,
    created_at,
    updated_at
FROM job_attempts;

CREATE TRIGGER trg_attempt_execution_identity_immutable
BEFORE UPDATE OF provider_kind, provider_policy, execution_contract_version, execution_options_json
ON job_attempts
WHEN OLD.provider_kind IS NOT NEW.provider_kind
  OR OLD.provider_policy IS NOT NEW.provider_policy
  OR OLD.execution_contract_version IS NOT NEW.execution_contract_version
  OR OLD.execution_options_json IS NOT NEW.execution_options_json
BEGIN
    SELECT RAISE(ABORT, 'attempt execution identity is immutable');
END;

CREATE TRIGGER trg_attempt_provider_execution_insert
AFTER INSERT ON job_attempts
WHEN NEW.provider_kind IS NOT NULL
  AND NEW.provider_policy IS NOT NULL
  AND NEW.execution_contract_version IS NOT NULL
  AND NEW.execution_options_json IS NOT NULL
BEGIN
    INSERT INTO provider_executions (
        id,
        attempt_id,
        provider_kind,
        provider_policy,
        status,
        create_outcome,
        provider_handle,
        terminal_status,
        created_at,
        updated_at
    ) VALUES (
        NEW.id,
        NEW.id,
        NEW.provider_kind,
        NEW.provider_policy,
        CASE NEW.status
            WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
            WHEN 'SUBMITTING' THEN 'CREATING'
            WHEN 'RUNNING' THEN 'RUNNING'
            WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
            ELSE 'TERMINAL'
        END,
        NEW.submission_outcome,
        NEW.winning_runpod_job_id,
        NEW.runpod_terminal_status,
        NEW.created_at,
        NEW.updated_at
    );
END;

CREATE TRIGGER trg_attempt_provider_execution_update
AFTER UPDATE OF status, submission_outcome, winning_runpod_job_id,
    runpod_terminal_status, updated_at
ON job_attempts
WHEN NEW.provider_kind = 'runpod_serverless'
BEGIN
    UPDATE provider_executions
    SET
        status = CASE NEW.status
            WHEN 'SUBMISSION_PENDING' THEN 'PENDING'
            WHEN 'SUBMITTING' THEN 'CREATING'
            WHEN 'RUNNING' THEN 'RUNNING'
            WHEN 'CANCEL_REQUESTED' THEN 'CANCEL_REQUESTED'
            ELSE 'TERMINAL'
        END,
        create_outcome = NEW.submission_outcome,
        provider_handle = NEW.winning_runpod_job_id,
        terminal_status = NEW.runpod_terminal_status,
        updated_at = NEW.updated_at,
        version = version + 1
    WHERE attempt_id = NEW.id
      AND provider_kind = NEW.provider_kind
      AND provider_policy = NEW.provider_policy;
END;
