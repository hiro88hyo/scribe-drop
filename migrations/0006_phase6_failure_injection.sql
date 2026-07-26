CREATE UNIQUE INDEX idx_job_events_one_source_mutation_per_job
ON job_events(job_id)
WHERE event_type = 'source_mutated';
