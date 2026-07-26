"""Safe, allowlisted worker failures."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .contracts import WorkerErrorCode


class WorkerError(Exception):
    """Failure whose code is safe for logs and RunPod output."""

    def __init__(self, code: WorkerErrorCode) -> None:
        """Retain only an allowlisted code, never an upstream exception."""
        super().__init__(code)
        self.code = code
