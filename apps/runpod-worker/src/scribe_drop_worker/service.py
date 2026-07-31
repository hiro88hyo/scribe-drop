"""Claim-first RunPod worker application service."""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Final, Literal, Protocol

from .artifacts import Artifact, build_artifact_bundle
from .contracts import (
    ClaimResponse,
    RunpodClaimDeduplicated,
    RunpodClaimGranted,
    RunpodClaimRequest,
    RunpodHeartbeatRequest,
    RunpodHeartbeatResponse,
    RunpodJobEnvelope,
    WorkerCompletedOutput,
    WorkerDeduplicatedOutput,
    WorkerFailedOutput,
)
from .errors import WorkerError
from .http_client import (
    CapabilityHttpClient,
    SourceDownloadExpectation,
    ValidatedCapabilityPaths,
)
from .media import FfprobeMediaProbe, MediaInfo
from .transcription import FasterWhisperTranscriber, TranscriptionResult
from .url_policy import UrlPolicy

if TYPE_CHECKING:
    from collections.abc import Callable

    from .config import WorkerSettings
    from .logger import LogFields, WorkerLogger

INTERNAL_ERROR: Final = "INTERNAL_ERROR"
CANCELLED: Final = "CANCELLED"

WorkerOutput = WorkerCompletedOutput | WorkerDeduplicatedOutput | WorkerFailedOutput


class CapabilityHttpPort(Protocol):
    """Network operations available to the application service."""

    def claim(self, url: str, request: RunpodClaimRequest) -> ClaimResponse:
        """Claim one attempt."""

    def validate_claim_capabilities(
        self,
        claim: RunpodClaimGranted,
        *,
        job_id: str,
        attempt_id: str,
    ) -> ValidatedCapabilityPaths:
        """Validate all returned URLs and object keys."""

    def heartbeat(
        self,
        url: str,
        request: RunpodHeartbeatRequest,
    ) -> RunpodHeartbeatResponse:
        """Return the current cancellation state."""

    def download(
        self,
        url: str,
        destination: Path,
        *,
        expectation: SourceDownloadExpectation,
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """Download an exact source object."""

    def put_artifact(self, url: str, content: bytes, content_type: str) -> None:
        """Upload one artifact."""

    def put_manifest(self, url: str, content: bytes) -> None:
        """Upload the completion marker."""

    def close(self) -> None:
        """Close network resources."""


class MediaProbePort(Protocol):
    """Local media validation boundary."""

    def probe(self, source: Path, *, max_duration_seconds: float) -> MediaInfo:
        """Return validated media facts."""


class TranscriberPort(Protocol):
    """GPU transcription boundary."""

    def transcribe(
        self,
        source: Path,
        *,
        duration_seconds: float,
        on_segment: Callable[[], None] | None = None,
    ) -> TranscriptionResult:
        """Transcribe a validated local source."""


class HeartbeatController:
    """Rate-limit heartbeat calls and fail closed on cancellation or network failure."""

    def __init__(
        self,
        *,
        client: CapabilityHttpPort,
        request: RunpodHeartbeatRequest,
        url: str,
        interval_seconds: float,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        """Bind the heartbeat to one winning RunPod job."""
        self._client = client
        self._request = request
        self._url = url
        self._interval_seconds = interval_seconds
        self._clock = clock
        self._last_sent: float | None = None

    def check(self, *, force: bool = False) -> None:
        """Send when due and stop at the first explicit cancellation."""
        now = self._clock()
        if (
            not force
            and self._last_sent is not None
            and now - self._last_sent < self._interval_seconds
        ):
            return
        response = self._client.heartbeat(self._url, self._request)
        self._last_sent = now
        if response.cancel_requested:
            raise WorkerError(CANCELLED)


@dataclass(frozen=True, slots=True)
class RunpodWorkerDependencies:
    """External effects and clocks injected into one service."""

    client: CapabilityHttpPort
    media_probe: MediaProbePort
    transcriber: TranscriberPort
    logger: WorkerLogger
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    monotonic_clock: Callable[[], float] = monotonic


class RunpodWorkerService:
    """Execute one winning transcription and return allowlisted metadata only."""

    def __init__(
        self,
        *,
        settings: WorkerSettings,
        dependencies: RunpodWorkerDependencies,
    ) -> None:
        """Inject all external effects and clocks."""
        self._settings = settings
        self._client = dependencies.client
        self._media_probe = dependencies.media_probe
        self._transcriber = dependencies.transcriber
        self._logger = dependencies.logger
        self._now = dependencies.now
        self._monotonic_clock = dependencies.monotonic_clock

    def close(self) -> None:
        """Release network resources before worker refresh."""
        self._client.close()

    def run(self, envelope: RunpodJobEnvelope) -> WorkerOutput:
        """Run the claim-first state machine with fail-closed normalization."""
        identity = self._identity_fields(envelope)
        try:
            output = self._execute(envelope, identity)
        except WorkerError as error:
            status: Literal["cancelled", "failed"] = (
                "cancelled" if error.code == CANCELLED else "failed"
            )
            failure_fields: LogFields = {
                **identity,
                "status": status,
                "errorCode": error.code,
            }
            self._logger.emit(
                "warn" if status == "cancelled" else "error",
                "worker_failed",
                failure_fields,
            )
            return WorkerFailedOutput(
                schemaVersion=1,
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                status=status,
                errorCode=error.code,
                manifestWritten=False,
            )
        except Exception:  # noqa: BLE001 - outer boundary must hide all third-party details.
            self._logger.emit(
                "error",
                "worker_failed",
                {**identity, "status": "failed", "errorCode": INTERNAL_ERROR},
            )
            return WorkerFailedOutput(
                schemaVersion=1,
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                status="failed",
                errorCode=INTERNAL_ERROR,
                manifestWritten=False,
            )
        else:
            return output

    def _execute(
        self,
        envelope: RunpodJobEnvelope,
        identity: LogFields,
    ) -> WorkerOutput:
        self._logger.emit("info", "claim_started", identity)
        claim = self._client.claim(
            self._settings.claim_url,
            RunpodClaimRequest(
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                runpodJobId=envelope.id,
                claimToken=envelope.input.claim_token,
            ),
        )
        if isinstance(claim, RunpodClaimDeduplicated):
            self._logger.emit(
                "info",
                "claim_deduplicated",
                {**identity, "status": "deduplicated"},
            )
            return WorkerDeduplicatedOutput(
                schemaVersion=1,
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                status="deduplicated",
                manifestWritten=False,
            )
        output = self._run_winner(envelope, claim, identity)
        self._logger.emit(
            "info",
            "worker_completed",
            {
                **identity,
                "status": "completed",
                "audioDurationSeconds": output.duration_seconds,
                "segmentCount": output.segment_count,
            },
        )
        return output

    def _run_winner(
        self,
        envelope: RunpodJobEnvelope,
        claim: RunpodClaimGranted,
        identity: LogFields,
    ) -> WorkerCompletedOutput:
        self._validate_expiry(claim.expires_at)
        paths = self._client.validate_claim_capabilities(
            claim,
            job_id=envelope.input.job_id,
            attempt_id=envelope.input.attempt_id,
        )
        self._logger.emit("info", "claim_granted", {**identity, "status": "running"})
        heartbeat = HeartbeatController(
            client=self._client,
            request=RunpodHeartbeatRequest(
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                runpodJobId=envelope.id,
                heartbeatToken=claim.heartbeat.token,
            ),
            url=claim.heartbeat.url,
            interval_seconds=self._settings.heartbeat_interval_seconds,
            clock=self._monotonic_clock,
        )
        heartbeat.check(force=True)
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-",
            dir="/tmp",
        ) as task_directory:
            source = Path(task_directory) / "source.bin"
            source_size = self._client.download(
                claim.source.get_url,
                source,
                expectation=SourceDownloadExpectation(
                    size_bytes=claim.source.expected_size_bytes,
                    etag=claim.source.expected_etag,
                    max_size_bytes=self._settings.max_source_bytes,
                ),
                on_chunk=heartbeat.check,
            )
            self._logger.emit(
                "info",
                "download_completed",
                {**identity, "sourceSizeBytes": source_size},
            )
            media = self._media_probe.probe(
                source,
                max_duration_seconds=self._settings.max_duration_seconds,
            )
            self._logger.emit(
                "info",
                "media_validated",
                {
                    **identity,
                    "audioDurationSeconds": media.duration_seconds,
                    "sourceSizeBytes": source_size,
                },
            )
            heartbeat.check(force=True)
            self._logger.emit(
                "info",
                "transcription_started",
                {
                    **identity,
                    "audioDurationSeconds": media.duration_seconds,
                    "sourceSizeBytes": source_size,
                },
            )
            transcription = self._transcriber.transcribe(
                source,
                duration_seconds=media.duration_seconds,
                on_segment=heartbeat.check,
            )
            self._logger.emit(
                "info",
                "transcription_completed",
                {
                    **identity,
                    "audioDurationSeconds": media.duration_seconds,
                    "segmentCount": len(transcription.segments),
                },
            )
            bundle = build_artifact_bundle(
                job_id=envelope.input.job_id,
                attempt_id=envelope.input.attempt_id,
                transcription=transcription,
                keys=paths.result_keys,
            )
            self._upload_artifact(
                claim.results.markdown_put_url,
                bundle.markdown,
                identity,
                heartbeat,
            )
            self._upload_artifact(
                claim.results.json_put_url,
                bundle.json_artifact,
                identity,
                heartbeat,
            )
            self._upload_artifact(
                claim.results.srt_put_url,
                bundle.srt,
                identity,
                heartbeat,
            )
            self._client.put_manifest(claim.results.manifest_put_url, bundle.manifest)
            self._logger.emit(
                "info",
                "manifest_uploaded",
                {**identity, "artifactKind": "manifest"},
            )
            return WorkerCompletedOutput(
                schemaVersion=1,
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                status="completed",
                durationSeconds=media.duration_seconds,
                detectedLanguage=transcription.language,
                segmentCount=len(transcription.segments),
                manifestWritten=True,
            )

    def _upload_artifact(
        self,
        url: str,
        artifact: Artifact,
        identity: LogFields,
        heartbeat: HeartbeatController,
    ) -> None:
        self._client.put_artifact(url, artifact.content, artifact.content_type)
        self._logger.emit(
            "info",
            "artifact_uploaded",
            {**identity, "artifactKind": artifact.kind},
        )
        heartbeat.check()

    def _validate_expiry(self, expires_at: str) -> None:
        expiry = datetime.fromisoformat(expires_at)
        if expiry <= self._now():
            raise WorkerError(INTERNAL_ERROR)

    @staticmethod
    def _identity_fields(envelope: RunpodJobEnvelope) -> LogFields:
        return {
            "jobId": envelope.input.job_id,
            "attemptId": envelope.input.attempt_id,
            "runpodJobId": envelope.id,
        }


def build_default_service(settings: WorkerSettings, logger: WorkerLogger) -> RunpodWorkerService:
    """Compose production adapters without loading the Whisper model."""
    policy = UrlPolicy(
        orchestrator_host=settings.orchestrator_host,
        source_hosts=settings.source_hosts,
        result_hosts=settings.result_hosts,
    )
    return RunpodWorkerService(
        settings=settings,
        dependencies=RunpodWorkerDependencies(
            client=CapabilityHttpClient(policy),
            media_probe=FfprobeMediaProbe(),
            transcriber=FasterWhisperTranscriber(settings.model_path),
            logger=logger,
        ),
    )
