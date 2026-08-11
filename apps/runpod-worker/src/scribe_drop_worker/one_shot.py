"""Synthetic Cloud Run one-shot runtime over the bounded transcription core."""

from __future__ import annotations

import base64
import importlib
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Final, Literal, Protocol, cast
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .bounded_artifacts import (
    ArtifactPublicationPlan,
    BoundedArtifactPublisher,
    StreamingArtifactUploadPort,
    TranscriptMetadataV2,
)
from .bounded_decoder import FfmpegFloat32Stream, PcmStream, decode_pcm_windows
from .bounded_inference import BoundedInferenceCoordinator
from .bounded_transcription import PromptTail, SegmentSpool, WindowSegmentMerger
from .cloud_run_bounded_gpu_benchmark import NativeArrayWhisperPort, NumpyWindowWhisperModel
from .cloud_run_contracts import (
    AckRequest,
    BootstrapRequest,
    BootstrapResponse,
    ClaimRequest,
    ClaimResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    RuntimeIdentity,
    TerminalRequest,
    TerminalResponse,
)
from .constants import MAX_DURATION_SECONDS, MAX_SOURCE_BYTES
from .errors import WorkerError
from .http_client import SourceDownloadExpectation
from .media import FfprobeMediaProbe, MediaInfo
from .transcription import create_faster_whisper_model

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from typing import BinaryIO

ONE_SHOT_OK: Final = "cloud-run-one-shot:ok\n"
ONE_SHOT_FAILED: Final = "cloud-run-one-shot:failed"
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - fixed memory-backed task root.
HEARTBEAT_INTERVAL_SECONDS: Final = 60.0
CONTROL_RETRY_COUNT: Final = 2
ENVIRONMENT_KEYS: Final = (
    "APP_ENV",
    "CLOUD_RUN_EXECUTION",
    "CLOUD_RUN_JOB",
    "CLOUD_RUN_TASK_ATTEMPT",
    "CLOUD_RUN_TASK_COUNT",
    "CLOUD_RUN_TASK_INDEX",
    "MODEL_PATH",
    "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID",
    "SCRIBE_DROP_EXECUTION_HANDLE",
    "SCRIBE_DROP_EXECUTION_POLICY",
    "SCRIBE_DROP_IDENTITY_AUDIENCE",
    "SCRIBE_DROP_ORCHESTRATOR_ORIGIN",
    "SCRIBE_DROP_RESULT_HOST",
    "SCRIBE_DROP_SOURCE_HOST",
)

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
CANCELLED: Final = "CANCELLED"
TRANSCRIPTION_FAILED: Final = "TRANSCRIPTION_FAILED"
SESSION_REJECTED: Final = "SESSION_REJECTED"
BOOTSTRAP_REJECTED: Final = "BOOTSTRAP_REJECTED"
INTERNAL_ERROR: Final = "INTERNAL_ERROR"
ALLOWED_RUNTIME_ERROR_CODES: Final[frozenset[str]] = frozenset(
    {
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
    }
)


class OneShotRuntimeError(Exception):
    """Stable error safe for the terminal contract and process marker."""

    def __init__(self, code: RuntimeErrorCode) -> None:
        """Retain only an allowlisted code."""
        super().__init__(code)
        self.code = code


class UnknownControlOutcomeError(Exception):
    """Signal a response loss for an idempotent exact control request."""


class OneShotEnvironment(BaseModel):
    """Exact fixed Cloud Run task and controller-provided non-secret configuration."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    environment: Literal["staging", "production"] = Field(alias="APP_ENV")
    execution_name: str = Field(
        alias="CLOUD_RUN_EXECUTION",
        min_length=2,
        max_length=63,
        pattern=r"^[a-z][a-z0-9-]*(?:[a-z0-9])$",
    )
    job_name: str = Field(
        alias="CLOUD_RUN_JOB",
        min_length=2,
        max_length=63,
        pattern=r"^[a-z][a-z0-9-]*(?:[a-z0-9])$",
    )
    task_attempt: Literal["0"] = Field(alias="CLOUD_RUN_TASK_ATTEMPT")
    task_count: Literal["1"] = Field(alias="CLOUD_RUN_TASK_COUNT")
    task_index: Literal["0"] = Field(alias="CLOUD_RUN_TASK_INDEX")
    model_path: Literal["/opt/models/large-v3-turbo"] = Field(alias="MODEL_PATH")
    bootstrap_request_id: str = Field(
        alias="SCRIBE_DROP_BOOTSTRAP_REQUEST_ID",
        pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$",
    )
    execution_handle: str = Field(
        alias="SCRIBE_DROP_EXECUTION_HANDLE",
        min_length=43,
        max_length=43,
        pattern=r"^[A-Za-z0-9_-]{43}$",
    )
    execution_policy: Literal["cloud_run_jobs_l4_v1"] = Field(alias="SCRIBE_DROP_EXECUTION_POLICY")
    identity_audience: str = Field(alias="SCRIBE_DROP_IDENTITY_AUDIENCE")
    orchestrator_origin: str = Field(alias="SCRIBE_DROP_ORCHESTRATOR_ORIGIN")
    result_host: str = Field(alias="SCRIBE_DROP_RESULT_HOST")
    source_host: str = Field(alias="SCRIBE_DROP_SOURCE_HOST")

    @field_validator("identity_audience")
    @classmethod
    def identity_audience_is_fixed_endpoint(cls, value: str) -> str:
        """Require the exact bootstrap audience below the configured origin."""
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.path != "/internal/cloud-run/bootstrap"
            or parsed.query
            or parsed.fragment
        ):
            msg = "identity audience must be the fixed bootstrap endpoint"
            raise ValueError(msg)
        return value

    @field_validator("orchestrator_origin")
    @classmethod
    def origin_is_exact_https(cls, value: str) -> str:
        """Reject paths, credentials, non-default ports, and query material."""
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            msg = "orchestrator origin must be exact HTTPS"
            raise ValueError(msg)
        return f"https://{parsed.hostname.lower()}"

    @field_validator("result_host", "source_host")
    @classmethod
    def host_is_exact(cls, value: str) -> str:
        """Reject wildcard or path-bearing capability host configuration."""
        candidate = value.strip().rstrip(".").lower()
        if not candidate or any(part in candidate for part in ("*", "/", ":", "@")):
            msg = "capability host must be exact"
            raise ValueError(msg)
        try:
            return candidate.encode("idna").decode("ascii")
        except UnicodeError as error:
            msg = "capability host is invalid"
            raise ValueError(msg) from error


class IdentityTokenPort(Protocol):
    """Obtain a Cloud Run service identity token for one fixed audience."""

    def token(self, audience: str) -> str:
        """Return one short-lived Google-signed token."""


class RuntimeControlPort(Protocol):
    """Strict one-shot runtime control protocol."""

    def bootstrap(self, origin: str, request: BootstrapRequest) -> BootstrapResponse:
        """Verify built-in identity and return a durable challenge."""

    def claim(self, origin: str, request: ClaimRequest) -> ClaimResponse:
        """Consume the signed challenge and return exact capabilities."""

    def acknowledge(self, origin: str, request: AckRequest) -> None:
        """Acknowledge receipt of the exact claim response."""

    def heartbeat(self, origin: str, request: HeartbeatRequest) -> HeartbeatResponse:
        """Persist liveness and return cancellation state."""

    def terminal(self, origin: str, request: TerminalRequest) -> TerminalResponse:
        """Persist terminal facts and revoke the runtime session."""

    def close(self) -> None:
        """Close all network resources."""


class SourceDownloadPort(Protocol):
    """Stream an exact source object into task-local storage."""

    def download(
        self,
        url: str,
        destination: Path,
        *,
        expectation: SourceDownloadExpectation,
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """Download while enforcing declared size and ETag."""


@dataclass(frozen=True, slots=True)
class RuntimeKeyPair:
    """Memory-only public identity and signing closure."""

    public_key: str
    sign: Callable[[bytes], str]


@dataclass(frozen=True, slots=True)
class OneShotDependencies:
    """All external effects injected for deterministic local failure testing."""

    control: RuntimeControlPort
    identity: IdentityTokenPort
    source: SourceDownloadPort
    upload: StreamingArtifactUploadPort
    cuda_device_count: Callable[[], int]
    key_factory: Callable[[], RuntimeKeyPair]
    media_probe: Callable[[Path, float], MediaInfo]
    model_factory: Callable[[str], NativeArrayWhisperPort]
    pcm_stream_factory: Callable[[Path, int], PcmStream]
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    monotonic_clock: Callable[[], float] = monotonic
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT


@dataclass(frozen=True, slots=True)
class OneShotResult:
    """Only non-sensitive counters returned to the process boundary."""

    artifact_count: int
    duration_seconds: float
    error_code: RuntimeErrorCode | None
    manifest_written: bool
    segment_count: int
    status: Literal["succeeded", "failed", "cancelled"]


@dataclass(slots=True)
class _ExecutionFacts:
    """Incrementally retain only counters safe for a partial terminal report."""

    artifact_count: int = 0
    duration_seconds: float = 0.0
    manifest_written: bool = False
    segment_count: int = 0


class _CountingUpload(StreamingArtifactUploadPort):
    """Count successful exact-object writes without retaining artifact content."""

    def __init__(self, delegate: StreamingArtifactUploadPort, facts: _ExecutionFacts) -> None:
        self._delegate = delegate
        self._facts = facts

    def put_file(
        self,
        url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Increment only after the delegated upload succeeds."""
        self._delegate.put_file(
            url,
            content,
            content_type=content_type,
            size_bytes=size_bytes,
            sha256=sha256,
        )
        self._facts.artifact_count += 1

    def put_manifest(self, url: str, content: bytes) -> None:
        """Mark completion only after the manifest-last write succeeds."""
        self._delegate.put_manifest(url, content)
        self._facts.manifest_written = True


class RuntimeHeartbeat:
    """Monotonic session event sequencer with exact unknown-outcome retries."""

    def __init__(
        self,
        settings: OneShotEnvironment,
        claim: ClaimResponse,
        control: RuntimeControlPort,
        *,
        interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        """Bind one session and reserve sequence zero for acknowledgement."""
        self._settings = settings
        self._claim = claim
        self._control = control
        self._interval_seconds = interval_seconds
        self._clock = clock
        self._last_sent: float | None = None
        self._next_sequence = 0

    @property
    def next_sequence(self) -> int:
        """Return the sequence reserved for the next event."""
        return self._next_sequence

    def acknowledge(self) -> None:
        """Acknowledge the claim before downloading or initializing CUDA."""
        request = AckRequest(
            executionHandle=self._settings.execution_handle,
            sequence=self._next_sequence,
            sessionId=self._claim.session.session_id,
            sessionToken=self._claim.session.token,
            state="ready",
        )
        _retry_exact(lambda: self._control.acknowledge(self._settings.orchestrator_origin, request))
        self._next_sequence += 1

    def check(
        self,
        progress: Literal["bootstrap", "download", "transcribe", "publish"],
        *,
        force: bool = False,
    ) -> None:
        """Send one due heartbeat and fail closed on cancellation."""
        now = self._clock()
        if (
            not force
            and self._last_sent is not None
            and now - self._last_sent < self._interval_seconds
        ):
            return
        request = HeartbeatRequest(
            executionHandle=self._settings.execution_handle,
            progress=progress,
            sequence=self._next_sequence,
            sessionId=self._claim.session.session_id,
            sessionToken=self._claim.session.token,
        )
        response = _retry_exact(
            lambda: self._control.heartbeat(self._settings.orchestrator_origin, request)
        )
        self._next_sequence += 1
        self._last_sent = now
        if response.cancel_requested:
            raise OneShotRuntimeError(CANCELLED)

    def terminal(self, result: OneShotResult) -> None:
        """Persist exact terminal facts and tolerate one lost response."""
        request = TerminalRequest(
            artifactCount=result.artifact_count,
            durationSeconds=result.duration_seconds,
            errorCode=result.error_code,
            executionHandle=self._settings.execution_handle,
            manifestWritten=result.manifest_written,
            segmentCount=result.segment_count,
            sequence=self._next_sequence,
            sessionId=self._claim.session.session_id,
            sessionToken=self._claim.session.token,
            status=result.status,
        )
        _retry_exact(lambda: self._control.terminal(self._settings.orchestrator_origin, request))


class CloudRunOneShotService:
    """Bootstrap, claim, execute, report, and close one Cloud Run task."""

    def __init__(self, settings: OneShotEnvironment, dependencies: OneShotDependencies) -> None:
        """Bind immutable environment and replaceable ports."""
        self._settings = settings
        self._dependencies = dependencies

    def close(self) -> None:
        """Close the control client idempotently."""
        self._dependencies.control.close()

    def run(self) -> OneShotResult:
        """Run once, reporting any post-claim failure with a revoked terminal session."""
        heartbeat: RuntimeHeartbeat | None = None
        facts = _ExecutionFacts()
        try:
            claim = self._bootstrap_and_claim()
            heartbeat = RuntimeHeartbeat(
                self._settings,
                claim,
                self._dependencies.control,
                clock=self._dependencies.monotonic_clock,
            )
            self._require_unexpired_claim(claim)
            heartbeat.acknowledge()
            heartbeat.check("bootstrap", force=True)
            self._execute(claim, heartbeat, facts)
            result = OneShotResult(
                artifact_count=facts.artifact_count,
                duration_seconds=facts.duration_seconds,
                error_code=None,
                manifest_written=facts.manifest_written,
                segment_count=facts.segment_count,
                status="succeeded",
            )
        except OneShotRuntimeError as error:
            result = OneShotResult(
                artifact_count=facts.artifact_count,
                duration_seconds=facts.duration_seconds,
                error_code=error.code,
                manifest_written=False,
                segment_count=facts.segment_count,
                status="cancelled" if error.code == "CANCELLED" else "failed",
            )
        except WorkerError as error:
            code: RuntimeErrorCode = (
                cast("RuntimeErrorCode", error.code)
                if error.code in ALLOWED_RUNTIME_ERROR_CODES
                else "INTERNAL_ERROR"
            )
            result = OneShotResult(
                artifact_count=facts.artifact_count,
                duration_seconds=facts.duration_seconds,
                error_code=code,
                manifest_written=False,
                segment_count=facts.segment_count,
                status="cancelled" if code == "CANCELLED" else "failed",
            )
        except Exception:  # noqa: BLE001 - hide every native/network failure at process boundary.
            result = OneShotResult(
                artifact_count=facts.artifact_count,
                duration_seconds=facts.duration_seconds,
                error_code="INTERNAL_ERROR",
                manifest_written=False,
                segment_count=facts.segment_count,
                status="failed",
            )
        if heartbeat is not None:
            self._report_terminal(heartbeat, result)
        return result

    def _bootstrap_and_claim(self) -> ClaimResponse:
        key_pair = self._dependencies.key_factory()
        identity = RuntimeIdentity(
            bootstrapRequestId=self._settings.bootstrap_request_id,
            environment=self._settings.environment,
            executionHandle=self._settings.execution_handle,
            executionName=self._settings.execution_name,
            jobName=self._settings.job_name,
            policyId=self._settings.execution_policy,
            publicKey=key_pair.public_key,
            taskAttempt=0,
            taskCount=1,
            taskIndex=0,
        )
        bootstrap_request = BootstrapRequest(
            **identity.model_dump(by_alias=True),
            identityToken=self._dependencies.identity.token(self._settings.identity_audience),
        )
        bootstrap = _retry_exact(
            lambda: self._dependencies.control.bootstrap(
                self._settings.orchestrator_origin, bootstrap_request
            )
        )
        signature = key_pair.sign(
            frame_runtime_challenge(
                (
                    "scribe-drop-cloud-run-claim-v1",
                    bootstrap.challenge,
                    bootstrap.challenge_id,
                    self._settings.bootstrap_request_id,
                    self._settings.execution_handle,
                    self._settings.execution_name,
                    self._settings.job_name,
                )
            )
        )
        claim_request = ClaimRequest(
            bootstrapRequestId=self._settings.bootstrap_request_id,
            challengeId=bootstrap.challenge_id,
            environment=self._settings.environment,
            executionHandle=self._settings.execution_handle,
            executionName=self._settings.execution_name,
            jobName=self._settings.job_name,
            policyId=self._settings.execution_policy,
            signature=signature,
            taskAttempt=0,
            taskCount=1,
            taskIndex=0,
        )
        return _retry_exact(
            lambda: self._dependencies.control.claim(
                self._settings.orchestrator_origin, claim_request
            )
        )

    def _execute(
        self,
        claim: ClaimResponse,
        heartbeat: RuntimeHeartbeat,
        facts: _ExecutionFacts,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-cloud-run-one-shot-",
            dir=self._dependencies.temporary_root,
        ) as task_directory_value:
            task_directory = Path(task_directory_value)
            source = task_directory / "source.bin"
            self._dependencies.source.download(
                claim.source.get_url,
                source,
                expectation=SourceDownloadExpectation(
                    size_bytes=claim.source.expected_size_bytes,
                    etag=claim.source.expected_etag,
                    max_size_bytes=MAX_SOURCE_BYTES,
                ),
                on_chunk=lambda: heartbeat.check("download"),
            )
            heartbeat.check("download", force=True)
            media = self._dependencies.media_probe(source, MAX_DURATION_SECONDS)
            facts.duration_seconds = media.duration_seconds
            require_exact_cuda_device(self._dependencies.cuda_device_count)
            native_model = self._dependencies.model_factory(self._settings.model_path)
            prompt = PromptTail()
            with SegmentSpool(task_directory) as spool:
                coordinator = BoundedInferenceCoordinator(
                    model=NumpyWindowWhisperModel(native_model),
                    options=claim.options,
                    merger=WindowSegmentMerger(spool, prompt),
                    prompt=prompt,
                    on_segment=lambda: _record_segment_progress(facts, spool, heartbeat),
                )
                pcm_stream = self._dependencies.pcm_stream_factory(source, media.audio_stream_index)
                decode = decode_pcm_windows(
                    pcm_stream,
                    coordinator.consume,
                    on_progress=lambda: heartbeat.check("transcribe"),
                )
                heartbeat.check("transcribe", force=True)
                language = coordinator.language_result
                heartbeat.check("publish", force=True)
                publication = BoundedArtifactPublisher(
                    task_directory, _CountingUpload(self._dependencies.upload, facts)
                ).publish(
                    ArtifactPublicationPlan(
                        jobId=claim.job_id,
                        attemptId=claim.attempt_id,
                        options=claim.options,
                        metadata=TranscriptMetadataV2(
                            language=language.language,
                            languageProbability=language.probability,
                            durationSeconds=decode.duration_seconds,
                        ),
                        targets=claim.results.artifacts,
                        manifestPutUrl=claim.results.manifest_put_url,
                    ),
                    spool,
                    on_progress=lambda: heartbeat.check("publish"),
                )
                facts.duration_seconds = decode.duration_seconds
                facts.segment_count = spool.segment_count
                if publication.artifact_count != facts.artifact_count or not facts.manifest_written:
                    raise WorkerError(INTERNAL_ERROR)

    def _report_terminal(self, heartbeat: RuntimeHeartbeat, result: OneShotResult) -> None:
        try:
            heartbeat.terminal(result)
        except Exception:  # noqa: BLE001 - provider cleanup remains controller-owned.
            return

    def _require_unexpired_claim(self, claim: ClaimResponse) -> None:
        try:
            expires_at = datetime.fromisoformat(claim.session.expires_at)
        except ValueError:
            raise OneShotRuntimeError(SESSION_REJECTED) from None
        if expires_at <= self._dependencies.now():
            raise OneShotRuntimeError(SESSION_REJECTED)


def frame_runtime_challenge(fields: tuple[str, ...]) -> bytes:
    """Encode the TypeScript-compatible length-framed challenge message."""
    return "".join(f"{len(field.encode())}:{field}" for field in fields).encode()


def _record_segment_progress(
    facts: _ExecutionFacts,
    spool: SegmentSpool,
    heartbeat: RuntimeHeartbeat,
) -> None:
    """Update the safe partial counter after each validated raw segment callback."""
    facts.segment_count = spool.segment_count
    heartbeat.check("transcribe")


def create_runtime_key_pair() -> RuntimeKeyPair:
    """Generate a memory-only Ed25519 key and expose base64url values without padding."""
    private_key = Ed25519PrivateKey.generate()
    public_key = _encode_base64url(private_key.public_key().public_bytes_raw())

    def sign(message: bytes) -> str:
        return _encode_base64url(private_key.sign(message))

    return RuntimeKeyPair(public_key=public_key, sign=sign)


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _retry_exact[T](action: Callable[[], T]) -> T:
    last_error: UnknownControlOutcomeError | None = None
    for _attempt in range(CONTROL_RETRY_COUNT):
        try:
            return action()
        except UnknownControlOutcomeError as error:
            last_error = error
    raise OneShotRuntimeError(SESSION_REJECTED) from last_error


def _read_cuda_device_count() -> int:
    module = importlib.import_module("ctranslate2")
    counter = cast("Callable[[], int]", module.get_cuda_device_count)
    return counter()


def require_exact_cuda_device(device_count: Callable[[], int]) -> None:
    """Reject missing or multiple CUDA devices before model initialization."""
    try:
        count = device_count()
    except Exception:  # noqa: BLE001 - normalize native discovery details.
        raise OneShotRuntimeError(TRANSCRIPTION_FAILED) from None
    if count != 1:
        raise OneShotRuntimeError(TRANSCRIPTION_FAILED)


def _create_native_model(model_path: str) -> NativeArrayWhisperPort:
    return cast("NativeArrayWhisperPort", create_faster_whisper_model(model_path))


def _probe_media(source: Path, max_duration_seconds: float) -> MediaInfo:
    return FfprobeMediaProbe().probe(source, max_duration_seconds=max_duration_seconds)


def _create_pcm_stream(source: Path, audio_stream_index: int) -> PcmStream:
    return FfmpegFloat32Stream(source, audio_stream_index=audio_stream_index)


def load_one_shot_environment(environment: Mapping[str, str]) -> OneShotEnvironment:
    """Select and validate only approved variables without retaining the process environment."""
    selected = {key: environment.get(key) for key in ENVIRONMENT_KEYS}
    try:
        settings = OneShotEnvironment.model_validate(selected)
    except ValidationError:
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED) from None
    if settings.identity_audience != (
        f"{settings.orchestrator_origin}/internal/cloud-run/bootstrap"
    ):
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED)
    return settings


def main(environment: Mapping[str, str] | None = None) -> None:
    """Load production adapters lazily and emit only an allowlisted terminal marker."""
    service: CloudRunOneShotService | None = None
    try:
        settings = load_one_shot_environment(os.environ if environment is None else environment)
        from .cloud_run_http import (  # noqa: PLC0415 - avoid adapter/domain import cycle.
            create_one_shot_network_dependencies,
        )

        network = create_one_shot_network_dependencies(settings)
        service = CloudRunOneShotService(
            settings,
            OneShotDependencies(
                control=network.control,
                identity=network.identity,
                source=network.source,
                upload=network.upload,
                cuda_device_count=_read_cuda_device_count,
                key_factory=create_runtime_key_pair,
                media_probe=_probe_media,
                model_factory=_create_native_model,
                pcm_stream_factory=_create_pcm_stream,
            ),
        )
        result = service.run()
    except OneShotRuntimeError as failure:
        sys.stderr.write(f"{ONE_SHOT_FAILED}:{failure.code}\n")
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - never expose identity, capabilities, or native details.
        sys.stderr.write(f"{ONE_SHOT_FAILED}:INTERNAL_ERROR\n")
        raise SystemExit(1) from None
    finally:
        if service is not None:
            service.close()
    if result.status != "succeeded":
        sys.stderr.write(f"{ONE_SHOT_FAILED}:{result.error_code}\n")
        raise SystemExit(1)
    sys.stdout.write(ONE_SHOT_OK)


if __name__ == "__main__":
    main()
