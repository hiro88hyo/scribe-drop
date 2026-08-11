"""Tests for the isolated Cloud Run maximum-duration GPU benchmark."""

from __future__ import annotations

import wave
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from scribe_drop_worker.cloud_run_gpu_benchmark import (
    CHANNEL_COUNT,
    DEFAULT_BENCHMARK_PORTS,
    GPU_BENCHMARK_FAILED,
    GPU_BENCHMARK_OK,
    SAMPLE_RATE_HZ,
    SAMPLE_WIDTH_BYTES,
    WAVE_HEADER_SIZE,
    BenchmarkPorts,
    CloudRunGpuBenchmarkError,
    load_benchmark_environment,
    main,
    run_gpu_benchmark,
)
from scribe_drop_worker.constants import DEFAULT_MODEL_PATH, MAX_DURATION_SECONDS

if TYPE_CHECKING:
    from collections.abc import Iterable


def _environment() -> dict[str, str]:
    return {
        "CLOUD_RUN_EXECUTION": "scribe-drop-gpu-benchmark-abcde",
        "CLOUD_RUN_JOB": "scribe-drop-gpu-benchmark",
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": DEFAULT_MODEL_PATH,
    }


class FakeModel:
    """Observe the synthetic source and fixed full-scan decode options."""

    def __init__(self) -> None:
        """Initialize observations."""
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.frame_count = 0
        self.iterated = False

    def transcribe(self, audio: str, **options: object) -> tuple[Iterable[object], object]:
        """Inspect the WAV while it exists and return a lazy result."""
        self.calls.append((audio, options))
        with wave.open(audio, "rb") as source:
            assert source.getnchannels() == 1
            assert source.getsampwidth() == SAMPLE_WIDTH_BYTES
            assert source.getframerate() == SAMPLE_RATE_HZ
            self.frame_count = source.getnframes()

        def segments() -> Iterable[object]:
            self.iterated = True
            yield object()

        return segments(), object()


def test_default_sparse_audio_has_exact_maximum_duration(tmp_path: Path) -> None:
    """The cloud candidate represents all eight hours without filling data pages."""
    source_path = tmp_path / "maximum-duration.wav"
    DEFAULT_BENCHMARK_PORTS.audio_factory(
        source_path,
        DEFAULT_BENCHMARK_PORTS.duration_seconds,
    )

    expected_frames = SAMPLE_RATE_HZ * MAX_DURATION_SECONDS
    expected_data_size = expected_frames * CHANNEL_COUNT * SAMPLE_WIDTH_BYTES
    assert source_path.stat().st_size == WAVE_HEADER_SIZE + expected_data_size
    with wave.open(str(source_path), "rb") as source:
        assert source.getnframes() == expected_frames
        assert source.getframerate() == SAMPLE_RATE_HZ
        assert source.getnchannels() == CHANNEL_COUNT
        assert source.getsampwidth() == SAMPLE_WIDTH_BYTES


def test_benchmark_full_scans_fixed_synthetic_audio_and_cleans_up(tmp_path: Path) -> None:
    """The bounded benchmark forces all audio through one fixed GPU inference."""
    model = FakeModel()
    model_paths: list[str] = []

    def model_factory(model_path: str) -> FakeModel:
        model_paths.append(model_path)
        return model

    run_gpu_benchmark(
        load_benchmark_environment(_environment()),
        ports=BenchmarkPorts(
            cuda_device_count=lambda: 1,
            model_factory=model_factory,
            temporary_root=tmp_path,
            duration_seconds=2,
        ),
    )

    assert DEFAULT_BENCHMARK_PORTS.duration_seconds == MAX_DURATION_SECONDS
    assert model_paths == [DEFAULT_MODEL_PATH]
    assert model.frame_count == SAMPLE_RATE_HZ * 2
    assert model.iterated is True
    assert len(model.calls) == 1
    source_path, options = model.calls[0]
    assert not Path(source_path).exists()
    assert options == {
        "beam_size": 5,
        "condition_on_previous_text": True,
        "language": None,
        "log_progress": False,
        "vad_filter": False,
        "word_timestamps": False,
    }


@pytest.mark.parametrize(
    "override",
    [
        {"CLOUD_RUN_EXECUTION": "foreign-execution"},
        {"CLOUD_RUN_JOB": "foreign-job"},
        {"CLOUD_RUN_TASK_ATTEMPT": "1"},
        {"CLOUD_RUN_TASK_COUNT": "2"},
        {"CLOUD_RUN_TASK_INDEX": "1"},
        {"MODEL_PATH": "/opt/models/unreviewed-model"},
    ],
)
def test_benchmark_rejects_drifted_environment(override: dict[str, str]) -> None:
    """The exact benchmark identity, task, attempt, and model cannot drift."""
    with pytest.raises(CloudRunGpuBenchmarkError) as failure:
        load_benchmark_environment({**_environment(), **override})
    assert failure.value.code == "ENVIRONMENT_INVALID"


def test_benchmark_rejects_missing_or_multiple_cuda_devices(tmp_path: Path) -> None:
    """The benchmark configuration must expose exactly one approved GPU."""
    settings = load_benchmark_environment(_environment())
    for count in (0, 2):

        def device_count(value: int = count) -> int:
            return value

        with pytest.raises(CloudRunGpuBenchmarkError) as failure:
            run_gpu_benchmark(
                settings,
                ports=BenchmarkPorts(
                    cuda_device_count=device_count,
                    model_factory=lambda _path: FakeModel(),
                    temporary_root=tmp_path,
                    duration_seconds=1,
                ),
            )
        assert failure.value.code == "CUDA_DEVICE_INVALID"


def test_benchmark_normalizes_media_and_inference_failures(tmp_path: Path) -> None:
    """Filesystem and native details cannot escape into Cloud Logging."""
    settings = load_benchmark_environment(_environment())

    def fail_media(_path: Path, _duration_seconds: int) -> None:
        msg = "sensitive filesystem detail"
        raise OSError(msg)

    with pytest.raises(CloudRunGpuBenchmarkError) as media_failure:
        run_gpu_benchmark(
            settings,
            ports=BenchmarkPorts(
                cuda_device_count=lambda: 1,
                model_factory=lambda _path: FakeModel(),
                audio_factory=fail_media,
                temporary_root=tmp_path,
                duration_seconds=1,
            ),
        )
    assert media_failure.value.code == "MEDIA_GENERATION_FAILED"
    assert "sensitive" not in str(media_failure.value)

    def fail_model(_model_path: str) -> FakeModel:
        msg = "sensitive native detail"
        raise RuntimeError(msg)

    with pytest.raises(CloudRunGpuBenchmarkError) as inference_failure:
        run_gpu_benchmark(
            settings,
            ports=BenchmarkPorts(
                cuda_device_count=lambda: 1,
                model_factory=fail_model,
                temporary_root=tmp_path,
                duration_seconds=1,
            ),
        )
    assert inference_failure.value.code == "INFERENCE_FAILED"
    assert "sensitive" not in str(inference_failure.value)


def test_main_emits_only_allowlisted_terminal_markers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Benchmark logs contain neither identifiers, generated output, nor exceptions."""
    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_gpu_benchmark.run_gpu_benchmark",
        lambda _settings: None,
    )
    main(_environment())
    captured = capsys.readouterr()
    assert captured.out == GPU_BENCHMARK_OK
    assert captured.err == ""

    with pytest.raises(SystemExit) as failure:
        main({**_environment(), "CLOUD_RUN_TASK_COUNT": "unsafe-value"})
    assert failure.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{GPU_BENCHMARK_FAILED}:ENVIRONMENT_INVALID\n"

    def fail_unexpectedly(_settings: object) -> None:
        msg = "sensitive implementation detail"
        raise RuntimeError(msg)

    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_gpu_benchmark.run_gpu_benchmark",
        fail_unexpectedly,
    )
    with pytest.raises(SystemExit) as unexpected_failure:
        main(_environment())
    assert unexpected_failure.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{GPU_BENCHMARK_FAILED}:INTERNAL_ERROR\n"
