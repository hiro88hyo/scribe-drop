"""Tests for the isolated Cloud Run GPU compatibility probe."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from scribe_drop_worker.cloud_run_gpu_probe import (
    GPU_PROBE_FAILED,
    GPU_PROBE_OK,
    CloudRunGpuProbeError,
    ProbePorts,
    load_probe_environment,
    main,
    run_gpu_probe,
)
from scribe_drop_worker.constants import DEFAULT_MODEL_PATH

if TYPE_CHECKING:
    from collections.abc import Iterable


def _environment() -> dict[str, str]:
    return {
        "CLOUD_RUN_EXECUTION": "scribe-drop-gpu-probe-abcde",
        "CLOUD_RUN_JOB": "scribe-drop-gpu-probe",
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": DEFAULT_MODEL_PATH,
    }


class FakeModel:
    """Record the fixed, content-free compatibility inference."""

    def __init__(self) -> None:
        """Initialize observations."""
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.iterated = False

    def transcribe(self, audio: str, **options: object) -> tuple[Iterable[object], object]:
        """Return a lazy result so the test can prove inference is consumed."""
        self.calls.append((audio, options))

        def segments() -> Iterable[object]:
            self.iterated = True
            yield object()

        return segments(), object()


def test_probe_runs_one_fixed_offline_gpu_inference(tmp_path: Path) -> None:
    """The bounded probe uses one CUDA device and never returns transcript text."""
    model = FakeModel()
    model_paths: list[str] = []

    def model_factory(model_path: str) -> FakeModel:
        model_paths.append(model_path)
        return model

    run_gpu_probe(
        load_probe_environment(_environment()),
        ports=ProbePorts(
            cuda_device_count=lambda: 1,
            model_factory=model_factory,
            temporary_root=tmp_path,
        ),
    )

    assert model_paths == [DEFAULT_MODEL_PATH]
    assert model.iterated is True
    assert len(model.calls) == 1
    source_path, options = model.calls[0]
    assert not Path(source_path).exists()
    assert options == {
        "beam_size": 1,
        "condition_on_previous_text": False,
        "language": "en",
        "log_progress": False,
        "vad_filter": False,
        "word_timestamps": False,
    }


@pytest.mark.parametrize(
    ("override", "code"),
    [
        ({"CLOUD_RUN_TASK_ATTEMPT": "1"}, "ENVIRONMENT_INVALID"),
        ({"CLOUD_RUN_TASK_COUNT": "2"}, "ENVIRONMENT_INVALID"),
        ({"CLOUD_RUN_TASK_INDEX": "1"}, "ENVIRONMENT_INVALID"),
        ({"MODEL_PATH": "/opt/models/unreviewed-model"}, "ENVIRONMENT_INVALID"),
    ],
)
def test_probe_rejects_unbounded_or_drifted_job_environment(
    override: dict[str, str],
    code: str,
) -> None:
    """Retries, multiple tasks, and mutable model paths fail before GPU work."""
    with pytest.raises(CloudRunGpuProbeError) as failure:
        load_probe_environment({**_environment(), **override})
    assert failure.value.code == code


def test_probe_rejects_missing_or_multiple_cuda_devices(tmp_path: Path) -> None:
    """The job configuration must expose exactly the single approved GPU."""
    settings = load_probe_environment(_environment())
    for count in (0, 2):

        def device_count(value: int = count) -> int:
            return value

        with pytest.raises(CloudRunGpuProbeError) as failure:
            run_gpu_probe(
                settings,
                ports=ProbePorts(
                    cuda_device_count=device_count,
                    model_factory=lambda _path: FakeModel(),
                    temporary_root=tmp_path,
                ),
            )
        assert failure.value.code == "CUDA_DEVICE_INVALID"


def test_probe_normalizes_native_inference_failure(tmp_path: Path) -> None:
    """Native library details cannot escape into Cloud Logging."""

    def fail_factory(_model_path: str) -> FakeModel:
        msg = "sensitive native failure"
        raise RuntimeError(msg)

    with pytest.raises(CloudRunGpuProbeError) as failure:
        run_gpu_probe(
            load_probe_environment(_environment()),
            ports=ProbePorts(
                cuda_device_count=lambda: 1,
                model_factory=fail_factory,
                temporary_root=tmp_path,
            ),
        )
    assert failure.value.code == "INFERENCE_FAILED"
    assert "sensitive" not in str(failure.value)


def test_main_emits_only_allowlisted_terminal_markers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Cloud logs contain neither resource identifiers nor exception bodies."""
    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_gpu_probe.run_gpu_probe",
        lambda _settings: None,
    )
    main(_environment())
    captured = capsys.readouterr()
    assert captured.out == GPU_PROBE_OK
    assert captured.err == ""

    with pytest.raises(SystemExit) as failure:
        main({**_environment(), "CLOUD_RUN_TASK_COUNT": "unsafe-value"})
    assert failure.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{GPU_PROBE_FAILED}:ENVIRONMENT_INVALID\n"

    def fail_unexpectedly(_settings: object) -> None:
        msg = "sensitive implementation detail"
        raise RuntimeError(msg)

    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_gpu_probe.run_gpu_probe",
        fail_unexpectedly,
    )
    with pytest.raises(SystemExit) as unexpected_failure:
        main(_environment())
    assert unexpected_failure.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{GPU_PROBE_FAILED}:INTERNAL_ERROR\n"
