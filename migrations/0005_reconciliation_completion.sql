ALTER TABLE job_attempts
ADD COLUMN runpod_terminal_job_id TEXT;

ALTER TABLE job_attempts
ADD COLUMN runpod_terminal_status TEXT CHECK (
    runpod_terminal_status IS NULL
    OR runpod_terminal_status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
);

ALTER TABLE job_attempts
ADD COLUMN runpod_terminal_observed_at TEXT;

ALTER TABLE job_attempts
ADD COLUMN runpod_output_status TEXT CHECK (
    runpod_output_status IS NULL
    OR runpod_output_status IN ('completed', 'failed', 'cancelled', 'deduplicated')
);

ALTER TABLE job_attempts
ADD COLUMN runpod_output_error_code TEXT CHECK (
    runpod_output_error_code IS NULL
    OR runpod_output_error_code IN (
        'CLAIM_REJECTED',
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
);

ALTER TABLE job_attempts
ADD COLUMN runpod_manifest_written INTEGER CHECK (
    runpod_manifest_written IS NULL
    OR runpod_manifest_written IN (0, 1)
);

ALTER TABLE job_attempts
ADD COLUMN detected_language TEXT CHECK (
    detected_language IS NULL
    OR length(detected_language) BETWEEN 2 AND 35
);

ALTER TABLE job_attempts
ADD COLUMN segment_count INTEGER CHECK (
    segment_count IS NULL
    OR segment_count >= 0
);

ALTER TABLE job_attempts
ADD COLUMN media_duration_seconds REAL CHECK (
    media_duration_seconds IS NULL
    OR media_duration_seconds BETWEEN 0 AND 28800
);

CREATE INDEX idx_job_attempts_terminal
ON job_attempts(runpod_terminal_status, runpod_terminal_observed_at)
WHERE runpod_terminal_status IS NOT NULL;

CREATE UNIQUE INDEX idx_job_attempts_id_job
ON job_attempts(id, job_id);

CREATE TABLE job_artifacts (
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('markdown', 'json', 'srt')),
    object_key TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'results/%'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 2147483648),
    sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,

    PRIMARY KEY(attempt_id, format),
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id, job_id) REFERENCES job_attempts(id, job_id) ON DELETE CASCADE
);

CREATE INDEX idx_job_artifacts_job
ON job_artifacts(job_id, format);

CREATE UNIQUE INDEX idx_job_events_one_cancel_request_per_job
ON job_events(job_id)
WHERE event_type = 'job_cancel_requested';
