ALTER TABLE job_attempts
ADD COLUMN claim_issued_at TEXT;

ALTER TABLE job_attempts
ADD COLUMN claim_expires_at TEXT;

ALTER TABLE job_attempts
ADD COLUMN claim_consumed_at TEXT;

ALTER TABLE job_attempts
ADD COLUMN heartbeat_issued_at TEXT;
