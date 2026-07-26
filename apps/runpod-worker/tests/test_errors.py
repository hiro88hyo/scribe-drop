"""Tests for safe worker failures."""

from scribe_drop_worker.errors import WorkerError


def test_worker_error_retains_only_allowlisted_code() -> None:
    """The outer handler can normalize failures without upstream details."""
    error = WorkerError("SOURCE_DOWNLOAD_FAILED")
    assert error.code == "SOURCE_DOWNLOAD_FAILED"
    assert str(error) == "SOURCE_DOWNLOAD_FAILED"
