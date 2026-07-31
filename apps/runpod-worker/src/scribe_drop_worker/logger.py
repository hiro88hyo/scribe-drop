"""Allowlist-only structured logging for third-party worker logs."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, TypedDict, cast

if TYPE_CHECKING:
    from collections.abc import Callable

    from .contracts import WorkerErrorCode

LogEvent = Literal[
    "claim_started",
    "claim_deduplicated",
    "claim_granted",
    "download_completed",
    "media_validated",
    "transcription_started",
    "transcription_completed",
    "artifact_uploaded",
    "manifest_uploaded",
    "heartbeat_accepted",
    "worker_failed",
    "worker_completed",
]
LogLevel = Literal["error", "info", "warn"]
LogStatus = Literal["cancelled", "completed", "deduplicated", "failed", "running"]


class LogFields(TypedDict, total=False):
    """Only non-sensitive fields that may enter a worker log record."""

    jobId: str
    attemptId: str
    runpodJobId: str
    status: LogStatus
    errorCode: WorkerErrorCode
    sourceSizeBytes: int
    audioDurationSeconds: float
    segmentCount: int
    artifactKind: Literal["json", "manifest", "markdown", "srt"]


class WorkerLogger:
    """Serialize only typed, pre-approved event fields."""

    def __init__(
        self,
        *,
        environment: Literal["local", "staging", "production"],
        sink: Callable[[str], None] = print,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        """Configure a safe sink and deterministic clock."""
        self._environment = environment
        self._sink = sink
        self._now = now

    def emit(
        self,
        level: LogLevel,
        event: LogEvent,
        fields: LogFields | None = None,
    ) -> None:
        """Emit deterministic JSON without accepting messages or arbitrary metadata."""
        record: dict[str, str | int | float] = {
            "environment": self._environment,
            "event": event,
            "level": level,
            "service": "runpod-worker",
            "timestamp": self._now().isoformat().replace("+00:00", "Z"),
        }
        if fields is not None:
            record.update(cast("dict[str, str | int | float]", fields))
        self._sink(json.dumps(record, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
