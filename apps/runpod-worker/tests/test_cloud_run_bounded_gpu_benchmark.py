"""Tests for the isolated bounded Cloud Run GPU benchmark candidate."""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import numpy as np
import pytest

from scribe_drop_worker.cloud_run_bounded_gpu_benchmark import (
    BENCHMARK_JOB_NAME,
    BOUNDED_BENCHMARK_FAILED,
    BOUNDED_BENCHMARK_OK,
    DEFAULT_BOUNDED_BENCHMARK_PORTS,
    BoundedBenchmarkPorts,
    CloudRunBoundedBenchmarkError,
    DiscardingArtifactUpload,
    NumpyWindowWhisperModel,
    load_bounded_benchmark_environment,
    main,
    run_bounded_gpu_benchmark,
)
from scribe_drop_worker.constants import DEFAULT_MODEL_PATH, MAX_DURATION_SECONDS
from scribe_drop_worker.media import MediaInfo

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

    from numpy.typing import NDArray

ONE_SECOND_FLOAT32_BYTES: Final = 16_000 * 4
EXPECTED_ARTIFACT_COUNT: Final = 3


def _environment() -> dict[str, str]:
    return {
        "CLOUD_RUN_EXECUTION": "scribe-drop-bounded-gpu-benchmark-abcde",
        "CLOUD_RUN_JOB": BENCHMARK_JOB_NAME,
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": DEFAULT_MODEL_PATH,
    }


@dataclass
class NativeSegment:
    """Minimal native segment returned by the benchmark fake."""

    id: int
    start: float
    end: float
    text: str


@dataclass
class NativeInfo:
    """Minimal native language metadata returned by the benchmark fake."""

    language: str
    language_probability: float


class FakeNativeModel:
    """Observe the zero-copy float32 input and fixed benchmark options."""

    def __init__(self) -> None:
        """Initialize call and shared-memory observations."""
        self.calls: list[dict[str, object]] = []
        self.shared_memory = False

    def transcribe(
        self,
        audio: NDArray[np.float32],
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Return one deterministic segment after validating the ndarray."""
        self.calls.append(options)
        self.shared_memory = audio.base is not None
        assert audio.dtype == np.dtype("float32")
        assert audio.flags.writeable is False
        return [NativeSegment(0, 0.0, 0.5, "safe synthetic text")], NativeInfo("en", 0.9)


class BytesPcmStream:
    """Small float32 stream for the local benchmark test."""

    def __init__(self) -> None:
        """Create one second of zero-valued float32 PCM."""
        self._payload = bytes(ONE_SECOND_FLOAT32_BYTES)
        self._offset = 0

    def read(self, max_bytes: int) -> bytes:
        """Read at most the requested number of bytes."""
        chunk = self._payload[self._offset : self._offset + max_bytes]
        self._offset += len(chunk)
        return chunk

    def finish(self) -> None:
        """Accept the deterministic clean EOF."""
        return

    def abort(self) -> None:
        """No-op for the in-memory stream."""
        return


def test_numpy_adapter_uses_read_only_float32_view_without_copy() -> None:
    """The adapter does not recreate the whole window before model inference."""
    model = FakeNativeModel()
    adapter = NumpyWindowWhisperModel(model)
    pcm = memoryview(bytes(16)).toreadonly()
    try:
        segments, info = adapter.transcribe(pcm, vad_filter=False)
    finally:
        pcm.release()
    assert tuple(segments)
    assert isinstance(info, NativeInfo)
    assert model.shared_memory is True


@pytest.mark.parametrize("pcm", [b"", b"\x00"])
def test_numpy_adapter_rejects_empty_or_partial_float32(pcm: bytes) -> None:
    """Invalid native frame alignment never reaches faster-whisper."""
    model = FakeNativeModel()
    with pytest.raises(ValueError, match="alignment"):
        NumpyWindowWhisperModel(model).transcribe(memoryview(pcm))
    assert model.calls == []


def test_discarding_upload_verifies_declared_integrity() -> None:
    """The offline sink still verifies the streamed file size and digest."""
    payload = b"safe"
    upload = DiscardingArtifactUpload()
    upload.put_file(
        "https://storage.example.invalid/file?signature=dummy",
        io.BytesIO(payload),
        content_type="application/octet-stream",
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )
    assert upload.artifact_count == 1
    with pytest.raises(ValueError, match="integrity"):
        upload.put_file(
            "https://storage.example.invalid/file?signature=dummy",
            io.BytesIO(payload),
            content_type="application/octet-stream",
            size_bytes=len(payload) + 1,
            sha256=hashlib.sha256(payload).hexdigest(),
        )


def test_bounded_benchmark_runs_same_core_and_cleans_task_files(tmp_path: Path) -> None:
    """The local fake covers decode, inference, spool, all artifacts, and manifest-last."""
    model = FakeNativeModel()
    model_paths: list[str] = []
    observed_source: Path | None = None

    def audio_factory(destination: Path, duration_seconds: int) -> None:
        nonlocal observed_source
        assert duration_seconds == 1
        observed_source = destination
        destination.write_bytes(b"synthetic")

    def model_factory(path: str) -> FakeNativeModel:
        model_paths.append(path)
        return model

    result = run_bounded_gpu_benchmark(
        load_bounded_benchmark_environment(_environment()),
        ports=BoundedBenchmarkPorts(
            cuda_device_count=lambda: 1,
            model_factory=model_factory,
            audio_factory=audio_factory,
            media_probe=lambda _source, _limit: MediaInfo(
                audio_codec="pcm_s16le",
                audio_stream_index=0,
                duration_seconds=1.0,
                format_name="wav",
                stream_count=1,
            ),
            pcm_stream_factory=lambda _source, _index: BytesPcmStream(),
            temporary_root=tmp_path,
            duration_seconds=1,
        ),
    )

    assert DEFAULT_BOUNDED_BENCHMARK_PORTS.duration_seconds == MAX_DURATION_SECONDS
    assert model_paths == [DEFAULT_MODEL_PATH]
    assert observed_source is not None
    assert not observed_source.exists()
    assert result.duration_seconds == 1.0
    assert result.window_count == 1
    assert result.segment_count == 1
    assert result.artifact_count == EXPECTED_ARTIFACT_COUNT
    assert model.calls[0]["vad_filter"] is False


@pytest.mark.parametrize(
    "override",
    [
        {"CLOUD_RUN_EXECUTION": "foreign"},
        {"CLOUD_RUN_JOB": "foreign"},
        {"CLOUD_RUN_TASK_ATTEMPT": "1"},
        {"CLOUD_RUN_TASK_COUNT": "2"},
        {"CLOUD_RUN_TASK_INDEX": "1"},
        {"MODEL_PATH": "/opt/models/unreviewed"},
    ],
)
def test_bounded_benchmark_rejects_environment_drift(override: dict[str, str]) -> None:
    """Only the reviewed one-task, retry-zero candidate environment is accepted."""
    with pytest.raises(CloudRunBoundedBenchmarkError) as failure:
        load_bounded_benchmark_environment({**_environment(), **override})
    assert failure.value.code == "ENVIRONMENT_INVALID"


def test_bounded_benchmark_normalizes_device_and_media_failures(tmp_path: Path) -> None:
    """Native and filesystem details never enter the stable failure result."""
    settings = load_bounded_benchmark_environment(_environment())
    with pytest.raises(CloudRunBoundedBenchmarkError) as device_failure:
        run_bounded_gpu_benchmark(
            settings,
            ports=BoundedBenchmarkPorts(cuda_device_count=lambda: 0),
        )
    assert device_failure.value.code == "CUDA_DEVICE_INVALID"

    def fail_media(_path: Path, _duration: int) -> None:
        msg = "sensitive path"
        raise OSError(msg)

    with pytest.raises(CloudRunBoundedBenchmarkError) as media_failure:
        run_bounded_gpu_benchmark(
            settings,
            ports=BoundedBenchmarkPorts(
                cuda_device_count=lambda: 1,
                audio_factory=fail_media,
                temporary_root=tmp_path,
            ),
        )
    assert media_failure.value.code == "MEDIA_GENERATION_FAILED"
    assert "sensitive" not in str(media_failure.value)


def test_bounded_benchmark_normalizes_device_inference_and_scratch_failures(
    tmp_path: Path,
) -> None:
    """Provider, model, and scratch failures expose only stable stage codes."""
    settings = load_bounded_benchmark_environment(_environment())

    def fail_device() -> int:
        msg = "sensitive cuda detail"
        raise RuntimeError(msg)

    with pytest.raises(CloudRunBoundedBenchmarkError) as device_failure:
        run_bounded_gpu_benchmark(
            settings,
            ports=BoundedBenchmarkPorts(cuda_device_count=fail_device),
        )
    assert device_failure.value.code == "CUDA_DEVICE_INVALID"

    def audio_factory(destination: Path, _duration_seconds: int) -> None:
        destination.write_bytes(b"synthetic")

    def fail_model(_path: str) -> FakeNativeModel:
        msg = "sensitive model detail"
        raise RuntimeError(msg)

    with pytest.raises(CloudRunBoundedBenchmarkError) as inference_failure:
        run_bounded_gpu_benchmark(
            settings,
            ports=BoundedBenchmarkPorts(
                cuda_device_count=lambda: 1,
                model_factory=fail_model,
                audio_factory=audio_factory,
                media_probe=lambda _source, _limit: MediaInfo(
                    audio_codec="pcm_s16le",
                    audio_stream_index=0,
                    duration_seconds=1.0,
                    format_name="wav",
                    stream_count=1,
                ),
                temporary_root=tmp_path,
                duration_seconds=1,
            ),
        )
    assert inference_failure.value.code == "INFERENCE_FAILED"

    with pytest.raises(CloudRunBoundedBenchmarkError) as scratch_failure:
        run_bounded_gpu_benchmark(
            settings,
            ports=BoundedBenchmarkPorts(
                cuda_device_count=lambda: 1,
                temporary_root=tmp_path / "missing",
            ),
        )
    assert scratch_failure.value.code == "MEDIA_GENERATION_FAILED"


def test_main_emits_only_allowlisted_markers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Cloud logs receive neither identifiers, transcript text, nor native exceptions."""
    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_bounded_gpu_benchmark.run_bounded_gpu_benchmark",
        lambda _settings: None,
    )
    main(_environment())
    captured = capsys.readouterr()
    assert captured.out == BOUNDED_BENCHMARK_OK
    assert captured.err == ""

    with pytest.raises(SystemExit):
        main({**_environment(), "CLOUD_RUN_TASK_COUNT": "unsafe"})
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{BOUNDED_BENCHMARK_FAILED}:ENVIRONMENT_INVALID\n"

    def fail(_settings: object) -> None:
        msg = "sensitive native detail"
        raise RuntimeError(msg)

    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_bounded_gpu_benchmark.run_bounded_gpu_benchmark",
        fail,
    )
    with pytest.raises(SystemExit):
        main(_environment())
    captured = capsys.readouterr()
    assert captured.err == f"{BOUNDED_BENCHMARK_FAILED}:INTERNAL_ERROR\n"
