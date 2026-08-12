"""Application service tests for claim-first worker execution."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

from scribe_drop_worker.artifacts import ResultArtifactKeys
from scribe_drop_worker.config import WorkerSettings, load_settings
from scribe_drop_worker.contracts import (
    ClaimResponse,
    RunpodClaimDeduplicated,
    RunpodClaimGranted,
    RunpodClaimRequest,
    RunpodHeartbeatRequest,
    RunpodHeartbeatResponse,
    RunpodJobEnvelope,
    TranscriptSegment,
)
from scribe_drop_worker.errors import WorkerError
from scribe_drop_worker.http_client import (
    SourceDownloadExpectation,
    ValidatedCapabilityPaths,
)
from scribe_drop_worker.logger import WorkerLogger
from scribe_drop_worker.media import MediaInfo
from scribe_drop_worker.service import RunpodWorkerDependencies, RunpodWorkerService
from scribe_drop_worker.transcription import TranscriptionResult

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
TOKEN: Final = "A" * 43
OWNER_HASH: Final = "a" * 32
PREFIX: Final = f"results/{OWNER_HASH}/{JOB_ID}/{ATTEMPT_ID}/"
SOURCE_BYTES: Final = b"audio"
MAX_TEST_DURATION_SECONDS: Final = 120
ARTIFACT_UPLOAD_FAILED: Final = "ARTIFACT_UPLOAD_FAILED"
FAILED_ARTIFACT_NUMBER: Final = 2


def settings() -> WorkerSettings:
    """Return validated local settings without secrets."""
    return load_settings(
        {
            "APP_ENV": "local",
            "ORCHESTRATOR_ORIGIN": "https://hooks.example.invalid",
            "ALLOWED_SOURCE_HOSTS": "storage.example.invalid",
            "ALLOWED_RESULT_HOSTS": "storage.example.invalid",
            "MAX_SOURCE_BYTES": "1024",
            "MAX_DURATION_SECONDS": "120",
            "HEARTBEAT_INTERVAL_SECONDS": "120",
            "MODEL_PATH": "/opt/models/large-v3-turbo",
        }
    )


def envelope() -> RunpodJobEnvelope:
    """Return one valid RunPod envelope."""
    return RunpodJobEnvelope.model_validate(
        {
            "id": "runpod-job",
            "input": {
                "schemaVersion": 1,
                "jobId": JOB_ID,
                "attemptId": ATTEMPT_ID,
                "claimToken": TOKEN,
            },
        }
    )


def granted_claim() -> RunpodClaimGranted:
    """Return deterministic winner capabilities."""
    base = f"https://storage.example.invalid/bucket/{PREFIX}"
    return RunpodClaimGranted.model_validate(
        {
            "granted": True,
            "source": {
                "getUrl": (
                    "https://storage.example.invalid/bucket/"
                    f"incoming/{OWNER_HASH}/{JOB_ID}/{'b' * 22}/source.mp3?signature=redacted"
                ),
                "expectedSizeBytes": len(SOURCE_BYTES),
                "expectedEtag": "expected",
            },
            "results": {
                "markdownPutUrl": f"{base}transcript.md?signature=redacted",
                "jsonPutUrl": f"{base}transcript.json?signature=redacted",
                "srtPutUrl": f"{base}transcript.srt?signature=redacted",
                "manifestPutUrl": f"{base}manifest.json?signature=redacted",
            },
            "heartbeat": {
                "url": "https://hooks.example.invalid/internal/runpod/heartbeat",
                "token": TOKEN,
            },
            "expiresAt": "2026-07-25T02:00:00.000Z",
        }
    )


class FakeHttpClient:
    """In-memory claim capability adapter."""

    def __init__(
        self,
        operations: list[str],
        *,
        claim: ClaimResponse,
        cancel_requested: bool = False,
        failed_artifact: int | None = None,
    ) -> None:
        """Configure claim, cancellation, and upload failure behavior."""
        self.operations = operations
        self.claim_response = claim
        self.cancel_requested = cancel_requested
        self.failed_artifact = failed_artifact
        self.artifact_count = 0
        self.manifest_written = False
        self.source_path: Path | None = None
        self.closed = False

    def claim(self, url: str, request: RunpodClaimRequest) -> ClaimResponse:
        """Return the configured claim response."""
        del url, request
        self.operations.append("claim")
        return self.claim_response

    def validate_claim_capabilities(
        self,
        claim: RunpodClaimGranted,
        *,
        job_id: str,
        attempt_id: str,
    ) -> ValidatedCapabilityPaths:
        """Return exact expected keys."""
        del claim, job_id, attempt_id
        self.operations.append("validate")
        return ValidatedCapabilityPaths(
            result_keys=ResultArtifactKeys(
                markdown=f"{PREFIX}transcript.md",
                json_artifact=f"{PREFIX}transcript.json",
                srt=f"{PREFIX}transcript.srt",
            ),
            manifest_key=f"{PREFIX}manifest.json",
        )

    def heartbeat(
        self,
        url: str,
        request: RunpodHeartbeatRequest,
    ) -> RunpodHeartbeatResponse:
        """Return deterministic cancellation state."""
        del url, request
        self.operations.append("heartbeat")
        return RunpodHeartbeatResponse(cancelRequested=self.cancel_requested)

    def download(
        self,
        url: str,
        destination: Path,
        *,
        expectation: SourceDownloadExpectation,
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """Write one local source file."""
        del url
        self.operations.append("download")
        assert expectation.size_bytes == len(SOURCE_BYTES)
        destination.write_bytes(SOURCE_BYTES)
        self.source_path = destination
        if on_chunk is not None:
            on_chunk()
        return len(SOURCE_BYTES)

    def put_artifact(self, url: str, content: bytes, content_type: str) -> None:
        """Record artifact order and optionally fail."""
        del url, content, content_type
        self.artifact_count += 1
        self.operations.append(f"artifact:{self.artifact_count}")
        if self.failed_artifact == self.artifact_count:
            raise WorkerError(ARTIFACT_UPLOAD_FAILED)

    def put_manifest(self, url: str, content: bytes) -> None:
        """Record the completion marker."""
        del url, content
        self.operations.append("manifest")
        self.manifest_written = True

    def close(self) -> None:
        """Record lifecycle cleanup."""
        self.closed = True


class FakeMediaProbe:
    """Media probe fake that asserts source existence."""

    def __init__(self, operations: list[str]) -> None:
        """Share the service order trace."""
        self.operations = operations

    def probe(self, source: Path, *, max_duration_seconds: float) -> MediaInfo:
        """Return supported media facts."""
        assert source.exists()
        assert max_duration_seconds == MAX_TEST_DURATION_SECONDS
        self.operations.append("probe")
        return MediaInfo(
            audio_stream_index=0,
            duration_seconds=60.0,
            stream_count=1,
            format_name="mp3",
            audio_codec="mp3",
        )


class FakeTranscriber:
    """Transcriber fake that proves lazy invocation."""

    def __init__(self, operations: list[str], *, fail: bool = False) -> None:
        """Configure normal or unexpected failure behavior."""
        self.operations = operations
        self.fail = fail

    def transcribe(
        self,
        source: Path,
        *,
        duration_seconds: float,
        on_segment: Callable[[], None] | None = None,
    ) -> TranscriptionResult:
        """Return one safe segment."""
        assert source.exists()
        self.operations.append("transcribe")
        if self.fail:
            detail = "https://storage.example.invalid/?X-Amz-Signature=sensitive"
            raise RuntimeError(detail)
        if on_segment is not None:
            on_segment()
        return TranscriptionResult(
            language="ja",
            language_probability=0.99,
            duration_seconds=duration_seconds,
            segments=(TranscriptSegment(id=0, start=0.0, end=1.0, text="transcript text"),),
        )


def build_service(
    *,
    claim: ClaimResponse | None = None,
    cancel_requested: bool = False,
    failed_artifact: int | None = None,
    transcriber_fails: bool = False,
) -> tuple[RunpodWorkerService, FakeHttpClient, list[str], list[str]]:
    """Compose a service with all effects observable."""
    operations: list[str] = []
    records: list[str] = []
    client = FakeHttpClient(
        operations,
        claim=claim or granted_claim(),
        cancel_requested=cancel_requested,
        failed_artifact=failed_artifact,
    )
    service = RunpodWorkerService(
        settings=settings(),
        dependencies=RunpodWorkerDependencies(
            client=client,
            media_probe=FakeMediaProbe(operations),
            transcriber=FakeTranscriber(operations, fail=transcriber_fails),
            logger=WorkerLogger(
                environment="local",
                sink=records.append,
                now=lambda: datetime(2026, 7, 25, tzinfo=UTC),
            ),
            now=lambda: datetime(2026, 7, 25, tzinfo=UTC),
            monotonic_clock=lambda: 0.0,
        ),
    )
    return service, client, operations, records


def test_winner_runs_in_security_order_and_writes_manifest_last() -> None:
    """Only the winner reaches download, validation, inference, and completion."""
    service, client, operations, _records = build_service()
    result = service.run(envelope())

    assert result.status == "completed"
    assert operations == [
        "claim",
        "validate",
        "heartbeat",
        "download",
        "probe",
        "heartbeat",
        "transcribe",
        "artifact:1",
        "artifact:2",
        "artifact:3",
        "manifest",
    ]
    assert client.manifest_written is True
    assert client.source_path is not None
    assert client.source_path.exists() is False


def test_deduplicated_claim_stops_before_capability_or_local_work() -> None:
    """A losing RunPod job performs no expensive or privileged operation."""
    service, client, operations, _records = build_service(
        claim=RunpodClaimDeduplicated(deduplicated=True)
    )
    result = service.run(envelope())
    assert result.status == "deduplicated"
    assert operations == ["claim"]
    assert client.source_path is None


def test_cancelled_heartbeat_stops_before_download_and_model() -> None:
    """Cancellation after claim is fail-closed at the first safe point."""
    service, client, operations, _records = build_service(cancel_requested=True)
    result = service.run(envelope())
    assert result.status == "cancelled"
    assert result.error_code == "CANCELLED"
    assert operations == ["claim", "validate", "heartbeat"]
    assert client.manifest_written is False


def test_partial_artifact_failure_never_writes_manifest() -> None:
    """A lost PUT response can leave partial artifacts but never a manifest."""
    service, client, operations, records = build_service(failed_artifact=FAILED_ARTIFACT_NUMBER)
    result = service.run(envelope())
    assert result.status == "failed"
    assert result.error_code == "ARTIFACT_UPLOAD_FAILED"
    assert client.artifact_count == FAILED_ARTIFACT_NUMBER
    assert operations[-2:] == ["artifact:1", "artifact:2"]
    assert "manifest" not in operations
    assert client.manifest_written is False
    combined = "\n".join(records)
    assert "transcript text" not in combined
    assert "signature=redacted" not in combined


def test_unexpected_transcriber_exception_is_not_logged_or_returned() -> None:
    """URLs and native exception details are normalized at the outer boundary."""
    service, _client, _operations, records = build_service(transcriber_fails=True)
    result = service.run(envelope())
    combined = "\n".join(records)
    assert result.status == "failed"
    assert result.error_code == "INTERNAL_ERROR"
    assert "X-Amz-Signature" not in combined
    assert "storage.example.invalid" not in combined
    assert "transcript text" not in combined


def test_expired_capability_stops_before_url_validation() -> None:
    """A stale granted response cannot create local state."""
    expired = granted_claim().model_copy(update={"expires_at": "2026-07-24T23:59:59.000Z"})
    service, _client, operations, _records = build_service(claim=expired)
    result = service.run(envelope())
    assert result.status == "failed"
    assert result.error_code == "INTERNAL_ERROR"
    assert operations == ["claim"]
