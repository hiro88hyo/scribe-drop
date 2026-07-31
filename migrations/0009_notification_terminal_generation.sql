ALTER TABLE notification_outbox
ADD COLUMN job_version INTEGER CHECK (job_version IS NULL OR job_version >= 1);

UPDATE notification_outbox
SET job_version = (
  SELECT jobs.version
  FROM jobs
  WHERE jobs.id = notification_outbox.job_id
)
WHERE job_version IS NULL;
