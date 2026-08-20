"""Shared stable failures for the Cloud Run one-shot process and adapters."""

from __future__ import annotations

from typing import Final, Literal

RuntimeErrorCode = Literal[
    "BOOTSTRAP_REJECTED",
    "SESSION_REJECTED",
    "SOURCE_DOWNLOAD_FAILED",
    "SOURCE_SIZE_MISMATCH",
    "SOURCE_ETAG_MISMATCH",
    "INVALID_MEDIA",
    "DURATION_LIMIT_EXCEEDED",
    "TRANSCRIPTION_FAILED",
    "ARTIFACT_UPLOAD_FAILED",
    "MANIFEST_UPLOAD_FAILED",
    "CANCELLED",
    "INTERNAL_ERROR",
]

SESSION_REJECTED: Final = "SESSION_REJECTED"
BOOTSTRAP_REJECTED: Final = "BOOTSTRAP_REJECTED"


class OneShotRuntimeError(Exception):
    """Stable error safe for the terminal contract and process marker."""

    def __init__(self, code: RuntimeErrorCode) -> None:
        """Retain only an allowlisted code."""
        super().__init__(code)
        self.code = code


class UnknownControlOutcomeError(Exception):
    """Signal a response loss for an idempotent exact control request."""
