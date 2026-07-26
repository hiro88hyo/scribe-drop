"""Tests for the RunPod SDK handler lifecycle."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from scribe_drop_worker.contracts import (
    RunpodJobEnvelope,
    WorkerCompletedOutput,
)
from scribe_drop_worker.handler import create_handler
from scribe_drop_worker.logger import WorkerLogger

if TYPE_CHECKING:
    from scribe_drop_worker.service import WorkerOutput

JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"


class FakeRuntime:
    """Runtime fake with observable close behavior."""

    def __init__(self, *, close_fails: bool = False) -> None:
        """Configure cleanup behavior."""
        self.close_fails = close_fails
        self.closed = False

    def run(self, envelope: RunpodJobEnvelope) -> WorkerOutput:
        """Return safe successful metadata."""
        return WorkerCompletedOutput(
            schemaVersion=1,
            jobId=envelope.input.job_id,
            attemptId=envelope.input.attempt_id,
            status="completed",
            durationSeconds=60.0,
            detectedLanguage="ja",
            segmentCount=1,
            manifestWritten=True,
        )

    def close(self) -> None:
        """Record cleanup and optionally fail."""
        self.closed = True
        if self.close_fails:
            detail = "sensitive close detail"
            raise RuntimeError(detail)


def raw_job() -> dict[str, object]:
    """Return a valid minimal RunPod job."""
    return {
        "id": "runpod-job",
        "input": {
            "schemaVersion": 1,
            "jobId": JOB_ID,
            "attemptId": ATTEMPT_ID,
            "claimToken": "A" * 43,
        },
    }


def test_handler_always_requests_refresh_and_closes_runtime() -> None:
    """Successful metadata excludes the internal refresh control field after SDK handling."""
    runtime = FakeRuntime()
    handler = create_handler(
        runtime_factory=lambda: runtime,
        logger=WorkerLogger(environment="local", sink=lambda _record: None),
    )
    result = handler(raw_job())
    assert result["refresh_worker"] is True
    assert result["status"] == "completed"
    assert runtime.closed is True


def test_handler_rejects_invalid_input_before_runtime_construction() -> None:
    """Unknown nested input cannot reach claim or model construction."""
    constructed = False

    def factory() -> FakeRuntime:
        nonlocal constructed
        constructed = True
        return FakeRuntime()

    invalid = raw_job()
    input_value = invalid["input"]
    assert isinstance(input_value, dict)
    input_value["sourceUrl"] = "https://storage.example.invalid/sensitive"
    handler = create_handler(
        runtime_factory=factory,
        logger=WorkerLogger(environment="local", sink=lambda _record: None),
    )
    result = handler(invalid)
    assert result == {
        "refresh_worker": True,
        "schemaVersion": 1,
        "status": "failed",
        "errorCode": "INTERNAL_ERROR",
        "manifestWritten": False,
    }
    assert constructed is False


def test_handler_cleanup_failure_changes_result_to_safe_failure() -> None:
    """Refresh remains requested even when adapter cleanup fails."""
    runtime = FakeRuntime(close_fails=True)
    handler = create_handler(
        runtime_factory=lambda: runtime,
        logger=WorkerLogger(environment="local", sink=lambda _record: None),
    )
    result = handler(raw_job())
    assert result["refresh_worker"] is True
    assert result["status"] == "failed"
    assert result["errorCode"] == "INTERNAL_ERROR"
