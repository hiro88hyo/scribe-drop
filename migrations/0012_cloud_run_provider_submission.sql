ALTER TABLE provider_executions ADD COLUMN provider_version INTEGER CHECK (
    provider_version IS NULL OR provider_version >= 0
);

CREATE INDEX idx_provider_executions_provider_version
ON provider_executions(provider_kind, status, provider_version, updated_at, id);

CREATE TRIGGER trg_attempt_cloud_run_cancellation_update
AFTER UPDATE OF status, updated_at ON job_attempts
WHEN NEW.provider_kind = 'cloud_run_jobs'
  AND (
    (OLD.status = 'SUBMISSION_PENDING' AND NEW.status = 'CANCELLED')
    OR (
      OLD.status IN ('SUBMITTING', 'RUNNING')
      AND NEW.status = 'CANCEL_REQUESTED'
    )
  )
BEGIN
    UPDATE provider_executions
    SET
        status = CASE
            WHEN NEW.status = 'CANCELLED' THEN 'TERMINAL'
            ELSE 'CANCEL_REQUESTED'
        END,
        terminal_status = CASE
            WHEN NEW.status = 'CANCELLED' THEN 'CANCELLED'
            ELSE terminal_status
        END,
        cleanup_status = CASE
            WHEN NEW.status = 'CANCELLED' THEN 'SUCCEEDED'
            ELSE cleanup_status
        END,
        updated_at = NEW.updated_at,
        version = version + 1
    WHERE attempt_id = NEW.id
      AND provider_kind = NEW.provider_kind
      AND provider_policy = NEW.provider_policy;
END;
