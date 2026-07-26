ALTER TABLE jobs
ADD COLUMN deletion_not_before TEXT;

ALTER TABLE jobs
ADD COLUMN deletion_next_attempt_at TEXT;

ALTER TABLE jobs
ADD COLUMN deletion_attempt_count INTEGER NOT NULL DEFAULT 0
CHECK (deletion_attempt_count >= 0);

ALTER TABLE jobs
ADD COLUMN deletion_error_code TEXT
CHECK (
    deletion_error_code IS NULL
    OR deletion_error_code IN (
        'RUNPOD_CANCEL_FAILED',
        'R2_DELETE_FAILED',
        'D1_DELETE_FAILED'
    )
);

CREATE INDEX idx_jobs_deletion_pending
ON jobs(deletion_next_attempt_at, deletion_not_before, id)
WHERE deleted_at IS NOT NULL
  AND deletion_not_before IS NOT NULL;

CREATE UNIQUE INDEX idx_job_events_one_delete_request_per_job
ON job_events(job_id)
WHERE event_type = 'job_delete_requested';
