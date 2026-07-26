"""Tests for allowlist-only worker logging."""

from __future__ import annotations

from datetime import UTC, datetime

from scribe_drop_worker.logger import WorkerLogger


def test_logger_emits_only_safe_typed_fields() -> None:
    """Structured records contain identifiers and statistics, not arbitrary messages."""
    records: list[str] = []
    logger = WorkerLogger(
        environment="local",
        sink=records.append,
        now=lambda: datetime(2026, 7, 25, tzinfo=UTC),
    )
    logger.emit(
        "info",
        "download_completed",
        {
            "jobId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "attemptId": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
            "sourceSizeBytes": 1024,
        },
    )
    assert len(records) == 1
    assert '"sourceSizeBytes":1024' in records[0]
    for forbidden in (
        "X-Amz-Signature",
        "X-Amz-Credential",
        "claimToken",
        "heartbeatToken",
        "Authorization",
        "transcript text",
        "original filename",
    ):
        assert forbidden not in records[0]
