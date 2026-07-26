ALTER TABLE jobs
ADD COLUMN source_deleted_at TEXT;

ALTER TABLE job_attempts
ADD COLUMN results_deleted_at TEXT;

CREATE INDEX idx_jobs_source_retention
ON jobs(uploaded_at, created_at, id)
WHERE deleted_at IS NULL
  AND source_deleted_at IS NULL;

CREATE INDEX idx_job_attempts_result_retention
ON job_attempts(status, updated_at, id)
WHERE results_deleted_at IS NULL;

CREATE INDEX idx_jobs_audit_retention
ON jobs(status, created_at, id)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_job_events_one_retention_expiry_per_job
ON job_events(job_id)
WHERE event_type = 'job_retention_expired';
