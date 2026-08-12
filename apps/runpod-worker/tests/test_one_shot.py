"""Tests for the synthetic Cloud Run one-shot runtime state machine."""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

import scribe_drop_worker.one_shot as one_shot_module
from scribe_drop_worker import cloud_run_http
from scribe_drop_worker.cloud_run_contracts import (
    AckRequest,
    BootstrapRequest,
    BootstrapResponse,
    ClaimRequest,
    ClaimResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    TerminalRequest,
    TerminalResponse,
)
from scribe_drop_worker.media import MediaInfo
from scribe_drop_worker.one_shot import (
    CloudRunOneShotService,
    OneShotDependencies,
    OneShotResult,
    OneShotRuntimeError,
    RuntimeKeyPair,
    UnknownControlOutcomeError,
    create_runtime_key_pair,
    frame_runtime_challenge,
    load_one_shot_environment,
    main,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable
    from pathlib import Path
    from typing import BinaryIO

    import numpy as np
    from numpy.typing import NDArray

    from scribe_drop_worker.http_client import SourceDownloadExpectation

HANDLE: Final = "h" * 43
BOOTSTRAP_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAX"
CHALLENGE_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAY"
SESSION_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAZ"
JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
SESSION_TOKEN: Final = "t" * 43
CHALLENGE: Final = "c" * 43
ONE_SECOND_FLOAT32_BYTES: Final = 16_000 * 4
IDENTITY_TOKEN: Final = f"{'a' * 40}.{'b' * 40}.{'c' * 40}"
EXPECTED_ARTIFACT_COUNT: Final = 2
EXPECTED_EXACT_RETRIES: Final = 2
EXPECTED_TERMINAL_SEQUENCE: Final = 5
CANCEL_TERMINAL_SEQUENCE: Final = 2


def environment() -> dict[str, str]:
    """Return the exact reviewed task environment."""
    return {
        "APP_ENV": "staging",
        "CLOUD_RUN_EXECUTION": "sd-stg-execution-1",
        "CLOUD_RUN_JOB": "sd-stg-job-1",
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": "/opt/models/large-v3-turbo",
        "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID": BOOTSTRAP_ID,
        "SCRIBE_DROP_EXECUTION_HANDLE": HANDLE,
        "SCRIBE_DROP_EXECUTION_POLICY": "cloud_run_jobs_l4_v1",
        "SCRIBE_DROP_IDENTITY_AUDIENCE": (
            "https://orchestrator.example.invalid/internal/cloud-run/bootstrap"
        ),
        "SCRIBE_DROP_ORCHESTRATOR_ORIGIN": "https://orchestrator.example.invalid",
        "SCRIBE_DROP_RESULT_HOST": "storage.example.invalid",
        "SCRIBE_DROP_SOURCE_HOST": "storage.example.invalid",
    }


def claim_response(*, expires_at: str = "2026-08-11T01:00:00.000Z") -> ClaimResponse:
    """Return selected-format capability data bound to one exact attempt."""
    prefix = f"results/{'a' * 32}/{JOB_ID}/{ATTEMPT_ID}"
    return ClaimResponse.model_validate(
        {
            "attemptId": ATTEMPT_ID,
            "jobId": JOB_ID,
            "options": {
                "contractVersion": 2,
                "language": "ja",
                "model": "large-v3-turbo",
                "outputFormats": ("markdown", "json"),
                "vad": False,
            },
            "results": {
                "artifacts": (
                    {
                        "format": "markdown",
                        "key": f"{prefix}/transcript.md",
                        "putUrl": "https://storage.example.invalid/transcript.md?dummy=1",
                    },
                    {
                        "format": "json",
                        "key": f"{prefix}/transcript.json",
                        "putUrl": "https://storage.example.invalid/transcript.json?dummy=1",
                    },
                ),
                "manifestPutUrl": "https://storage.example.invalid/manifest.json?dummy=1",
            },
            "session": {
                "expiresAt": expires_at,
                "sessionId": SESSION_ID,
                "token": SESSION_TOKEN,
            },
            "source": {
                "expectedEtag": "dummy-etag",
                "expectedSizeBytes": 9,
                "getUrl": "https://storage.example.invalid/source.wav?dummy=1",
            },
        }
    )


@dataclass
class FakeIdentity:
    """Record the fixed audience without retaining a real credential."""

    audiences: list[str] = field(default_factory=list)

    def token(self, audience: str) -> str:
        """Return a syntactically valid dummy token."""
        self.audiences.append(audience)
        return IDENTITY_TOKEN


@dataclass
class FakeControl:
    """Record exact control requests and simulate response loss or cancellation."""

    claim_value: ClaimResponse = field(default_factory=claim_response)
    lose_bootstrap_once: bool = False
    lose_claim_once: bool = False
    lose_terminal_once: bool = False
    cancel_progress: str | None = None
    bootstraps: list[BootstrapRequest] = field(default_factory=list)
    claims: list[ClaimRequest] = field(default_factory=list)
    acknowledgements: list[AckRequest] = field(default_factory=list)
    heartbeats: list[HeartbeatRequest] = field(default_factory=list)
    terminals: list[TerminalRequest] = field(default_factory=list)
    closed: bool = False

    def bootstrap(self, _origin: str, request: BootstrapRequest) -> BootstrapResponse:
        """Return one deterministic challenge, losing the first response if requested."""
        self.bootstraps.append(request)
        if self.lose_bootstrap_once:
            self.lose_bootstrap_once = False
            raise UnknownControlOutcomeError
        return BootstrapResponse(
            challenge=CHALLENGE,
            challengeId=CHALLENGE_ID,
            expiresAt="2026-08-11T00:05:00.000Z",
        )

    def claim(self, _origin: str, request: ClaimRequest) -> ClaimResponse:
        """Return one deterministic session, losing the first response if requested."""
        self.claims.append(request)
        if self.lose_claim_once:
            self.lose_claim_once = False
            raise UnknownControlOutcomeError
        return self.claim_value

    def acknowledge(self, _origin: str, request: AckRequest) -> None:
        """Record the initial session event."""
        self.acknowledgements.append(request)

    def heartbeat(self, _origin: str, request: HeartbeatRequest) -> HeartbeatResponse:
        """Return cancellation only for the selected progress stage."""
        self.heartbeats.append(request)
        return HeartbeatResponse(cancelRequested=request.progress == self.cancel_progress)

    def terminal(self, _origin: str, request: TerminalRequest) -> TerminalResponse:
        """Record exact terminal replay after a simulated lost response."""
        self.terminals.append(request)
        if self.lose_terminal_once:
            self.lose_terminal_once = False
            raise UnknownControlOutcomeError
        return TerminalResponse(accepted=True, cleanupPending=True)

    def close(self) -> None:
        """Record deterministic resource cleanup."""
        self.closed = True


@dataclass
class FakeSource:
    """Create one task-local source and record immutable expectations."""

    calls: int = 0

    def download(
        self,
        _url: str,
        destination: Path,
        *,
        expectation: SourceDownloadExpectation,
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """Write the declared byte count and trigger progress once."""
        self.calls += 1
        payload = b"synthetic"
        assert expectation.size_bytes == len(payload)
        destination.write_bytes(payload)
        if on_chunk is not None:
            on_chunk()
        return len(payload)


@dataclass
class FakeUpload:
    """Record streaming artifacts and the manifest-last operation."""

    operations: list[str] = field(default_factory=list)
    manifest: bytes | None = None

    def put_file(
        self,
        _url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Verify the publisher declarations and discard content."""
        payload = content.read()
        assert len(payload) == size_bytes
        assert hashlib.sha256(payload).hexdigest() == sha256
        self.operations.append(content_type)

    def put_manifest(self, _url: str, content: bytes) -> None:
        """Retain only the small manifest for contract assertions."""
        self.operations.append("manifest")
        self.manifest = content


@dataclass
class NativeSegment:
    """Minimal native segment."""

    id: int
    start: float
    end: float
    text: str


@dataclass
class NativeInfo:
    """Minimal native metadata."""

    language: str
    language_probability: float


class FakeNativeModel:
    """Return one deterministic segment from a read-only float32 view."""

    def transcribe(
        self,
        audio: NDArray[np.float32],
        **_options: object,
    ) -> tuple[Iterable[object], object]:
        """Return a safe fixture while exercising the NumPy adapter."""
        assert audio.flags.writeable is False
        return [NativeSegment(0, 0.0, 0.5, "synthetic")], NativeInfo("ja", 0.99)


class BytesPcmStream:
    """Yield exactly one second of little-endian float32 PCM."""

    def __init__(self) -> None:
        """Create one fixed byte stream."""
        self._payload = bytes(ONE_SECOND_FLOAT32_BYTES)
        self._offset = 0

    def read(self, max_bytes: int) -> bytes:
        """Return one bounded chunk."""
        chunk = self._payload[self._offset : self._offset + max_bytes]
        self._offset += len(chunk)
        return chunk

    def finish(self) -> None:
        """Accept clean EOF."""

    def abort(self) -> None:
        """Accept idempotent abort."""


def dependencies(  # noqa: PLR0913 - explicit test ports keep cases readable.
    tmp_path: Path,
    control: FakeControl,
    *,
    identity: FakeIdentity | None = None,
    source: FakeSource | None = None,
    upload: FakeUpload | None = None,
    key_factory: Callable[[], RuntimeKeyPair] = create_runtime_key_pair,
) -> OneShotDependencies:
    """Build deterministic local ports around the production bounded core."""
    return OneShotDependencies(
        control=control,
        identity=identity or FakeIdentity(),
        source=source or FakeSource(),
        upload=upload or FakeUpload(),
        cuda_device_count=lambda: 1,
        key_factory=key_factory,
        media_probe=lambda _source, _limit: MediaInfo(
            audio_codec="pcm_s16le",
            audio_stream_index=0,
            duration_seconds=1.0,
            format_name="wav",
            stream_count=1,
        ),
        model_factory=lambda _path: FakeNativeModel(),
        pcm_stream_factory=lambda _source, _index: BytesPcmStream(),
        now=lambda: datetime(2026, 8, 11, tzinfo=UTC),
        monotonic_clock=lambda: 0.0,
        temporary_root=tmp_path,
    )


def test_one_shot_retries_exact_control_loss_runs_bounded_core_and_reports_terminal(
    tmp_path: Path,
) -> None:
    """The full fake path writes selected artifacts, manifest, terminal, and no residue."""
    control = FakeControl(
        lose_bootstrap_once=True,
        lose_claim_once=True,
        lose_terminal_once=True,
    )
    identity = FakeIdentity()
    source = FakeSource()
    upload = FakeUpload()
    service = CloudRunOneShotService(
        load_one_shot_environment(environment()),
        dependencies(tmp_path, control, identity=identity, source=source, upload=upload),
    )

    result = service.run()
    service.close()

    assert result.status == "succeeded"
    assert result.artifact_count == EXPECTED_ARTIFACT_COUNT
    assert result.manifest_written is True
    assert result.segment_count == 1
    assert len(control.bootstraps) == EXPECTED_EXACT_RETRIES
    assert control.bootstraps[0] == control.bootstraps[1]
    assert len(control.claims) == EXPECTED_EXACT_RETRIES
    assert control.claims[0] == control.claims[1]
    assert [request.sequence for request in control.acknowledgements] == [0]
    assert [request.sequence for request in control.heartbeats] == [1, 2, 3, 4]
    assert len(control.terminals) == EXPECTED_EXACT_RETRIES
    assert control.terminals[0] == control.terminals[1]
    assert control.terminals[0].sequence == EXPECTED_TERMINAL_SEQUENCE
    assert identity.audiences == [environment()["SCRIBE_DROP_IDENTITY_AUDIENCE"]]
    assert source.calls == 1
    assert upload.operations[-1] == "manifest"
    assert upload.manifest is not None
    assert json.loads(upload.manifest)["complete"] is True
    assert control.closed is True
    assert tuple(tmp_path.iterdir()) == ()


def test_generated_ephemeral_key_signs_the_exact_framed_challenge() -> None:
    """The memory-only Ed25519 public key verifies only the exact frame."""
    pair = create_runtime_key_pair()
    fields = ("\u03b1", CHALLENGE, CHALLENGE_ID)
    message = frame_runtime_challenge(fields)
    signature = base64.urlsafe_b64decode(pair.sign(message) + "==")
    public_key = base64.urlsafe_b64decode(pair.public_key + "=")
    Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)


def test_cancellation_before_download_reports_cancelled_without_gpu_or_source(
    tmp_path: Path,
) -> None:
    """Cancellation at the first heartbeat prevents every application capability effect."""
    control = FakeControl(cancel_progress="bootstrap")
    source = FakeSource()
    gpu_calls = 0
    ports = dependencies(tmp_path, control, source=source)

    def cuda_device_count() -> int:
        nonlocal gpu_calls
        gpu_calls += 1
        return 1

    service = CloudRunOneShotService(
        load_one_shot_environment(environment()),
        replace(ports, cuda_device_count=cuda_device_count),
    )
    result = service.run()

    assert result.status == "cancelled"
    assert result.error_code == "CANCELLED"
    assert source.calls == 0
    assert gpu_calls == 0
    assert control.terminals[0].sequence == CANCEL_TERMINAL_SEQUENCE


def test_expired_claim_is_terminally_rejected_before_ack_or_gpu(tmp_path: Path) -> None:
    """A stale claim session is revoked at sequence zero without application effects."""
    control = FakeControl(claim_value=claim_response(expires_at="2026-08-10T23:59:59.000Z"))
    service = CloudRunOneShotService(
        load_one_shot_environment(environment()),
        dependencies(tmp_path, control),
    )

    result = service.run()

    assert result.status == "failed"
    assert result.error_code == "SESSION_REJECTED"
    assert control.acknowledgements == []
    assert control.terminals[0].sequence == 0


def test_environment_drift_fails_before_identity_or_control(tmp_path: Path) -> None:
    """Wrong task cardinality and wrong identity audience fail at the first boundary."""
    del tmp_path
    for override in (
        {"CLOUD_RUN_TASK_COUNT": "2"},
        {"CLOUD_RUN_TASK_ATTEMPT": "1"},
        {
            "SCRIBE_DROP_IDENTITY_AUDIENCE": "https://wrong.example.invalid/internal/cloud-run/bootstrap"
        },
        {"SCRIBE_DROP_SOURCE_HOST": "*"},
    ):
        with pytest.raises(OneShotRuntimeError) as failure:
            load_one_shot_environment({**environment(), **override})
        assert failure.value.code == "BOOTSTRAP_REJECTED"


@dataclass(frozen=True)
class _FakeNetwork:
    control: object = field(default_factory=object)
    identity: object = field(default_factory=object)
    source: object = field(default_factory=object)
    upload: object = field(default_factory=object)


class _FakeMainService:
    """Replace native/application effects while testing the process boundary."""

    result = OneShotResult(
        artifact_count=1,
        duration_seconds=1.0,
        error_code=None,
        manifest_written=True,
        segment_count=1,
        status="succeeded",
    )
    closed = False

    def __init__(self, _settings: object, _dependencies: object) -> None:
        """Accept the fully constructed production dependency set."""

    def run(self) -> OneShotResult:
        """Return the configured safe terminal result."""
        return self.result

    def close(self) -> None:
        """Record process-boundary cleanup."""
        type(self).closed = True


def test_main_emits_only_success_marker_and_closes_network(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The executable boundary emits no identity or capability material."""
    _FakeMainService.closed = False
    monkeypatch.setattr(one_shot_module, "CloudRunOneShotService", _FakeMainService)
    monkeypatch.setattr(
        cloud_run_http,
        "create_one_shot_network_dependencies",
        lambda _settings: _FakeNetwork(),
    )

    main(environment())

    captured = capsys.readouterr()
    assert captured.out == "cloud-run-one-shot:ok\n"
    assert captured.err == ""
    assert _FakeMainService.closed is True


def test_main_normalizes_failed_result_and_adapter_exception(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Failure markers contain only stable codes and always close an existing service."""
    monkeypatch.setattr(one_shot_module, "CloudRunOneShotService", _FakeMainService)
    monkeypatch.setattr(
        cloud_run_http,
        "create_one_shot_network_dependencies",
        lambda _settings: _FakeNetwork(),
    )
    _FakeMainService.result = OneShotResult(
        artifact_count=0,
        duration_seconds=0.0,
        error_code="CANCELLED",
        manifest_written=False,
        segment_count=0,
        status="cancelled",
    )
    with pytest.raises(SystemExit):
        main(environment())
    assert capsys.readouterr().err == "cloud-run-one-shot:failed:CANCELLED\n"

    monkeypatch.setattr(
        cloud_run_http,
        "create_one_shot_network_dependencies",
        lambda _settings: (_ for _ in ()).throw(RuntimeError),
    )
    with pytest.raises(SystemExit):
        main(environment())
    assert capsys.readouterr().err == "cloud-run-one-shot:failed:INTERNAL_ERROR\n"
