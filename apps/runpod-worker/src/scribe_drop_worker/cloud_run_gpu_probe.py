"""Network-free, single-task GPU compatibility probe for Cloud Run Jobs."""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
import wave
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .transcription import ModelFactory, WhisperModelPort, create_faster_whisper_model

GPU_PROBE_OK: Final = "cloud-run-gpu-probe:ok\n"
GPU_PROBE_FAILED: Final = "cloud-run-gpu-probe:failed"
SAMPLE_RATE_HZ: Final = 16_000
SAMPLE_DURATION_SECONDS: Final = 1
PROBE_ENVIRONMENT_KEYS: Final = (
    "CLOUD_RUN_EXECUTION",
    "CLOUD_RUN_JOB",
    "CLOUD_RUN_TASK_ATTEMPT",
    "CLOUD_RUN_TASK_COUNT",
    "CLOUD_RUN_TASK_INDEX",
    "MODEL_PATH",
)

ProbeErrorCode = Literal[
    "CUDA_DEVICE_INVALID",
    "ENVIRONMENT_INVALID",
    "INFERENCE_FAILED",
    "INTERNAL_ERROR",
]
CUDA_DEVICE_INVALID: Final[ProbeErrorCode] = "CUDA_DEVICE_INVALID"
ENVIRONMENT_INVALID: Final[ProbeErrorCode] = "ENVIRONMENT_INVALID"
INFERENCE_FAILED: Final[ProbeErrorCode] = "INFERENCE_FAILED"
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - mandated container scratch root.
CudaDeviceCount = Callable[[], int]


class CloudRunGpuProbeError(Exception):
    """Allowlisted probe failure that is safe to emit to Cloud Logging."""

    def __init__(self, code: ProbeErrorCode) -> None:
        """Discard upstream details and retain only a stable error code."""
        super().__init__(code)
        self.code = code


class CloudRunProbeEnvironment(BaseModel):
    """Exact Cloud Run execution boundary permitted by the isolated probe."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    execution: str = Field(
        alias="CLOUD_RUN_EXECUTION",
        min_length=1,
        max_length=63,
        pattern=r"^[a-z][a-z0-9-]*[a-z0-9]$",
    )
    job: str = Field(
        alias="CLOUD_RUN_JOB",
        min_length=1,
        max_length=63,
        pattern=r"^[a-z][a-z0-9-]*[a-z0-9]$",
    )
    task_attempt: Literal["0"] = Field(alias="CLOUD_RUN_TASK_ATTEMPT")
    task_count: Literal["1"] = Field(alias="CLOUD_RUN_TASK_COUNT")
    task_index: Literal["0"] = Field(alias="CLOUD_RUN_TASK_INDEX")
    model_path: str = Field(
        alias="MODEL_PATH",
        pattern=r"^/opt/models/large-v3-turbo$",
    )


def _read_cuda_device_count() -> int:
    module = importlib.import_module("ctranslate2")
    counter = cast("CudaDeviceCount", module.get_cuda_device_count)
    return counter()


@dataclass(frozen=True)
class ProbePorts:
    """Replaceable native and filesystem boundaries for the probe."""

    cuda_device_count: CudaDeviceCount = _read_cuda_device_count
    model_factory: ModelFactory = create_faster_whisper_model
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT


DEFAULT_PROBE_PORTS: Final = ProbePorts()


def load_probe_environment(environment: Mapping[str, str]) -> CloudRunProbeEnvironment:
    """Validate only allowlisted Cloud Run variables without retaining unrelated secrets."""
    selected = {key: environment.get(key) for key in PROBE_ENVIRONMENT_KEYS}
    try:
        return CloudRunProbeEnvironment.model_validate(selected)
    except ValidationError:
        raise CloudRunGpuProbeError(ENVIRONMENT_INVALID) from None


def _write_synthetic_audio(source: Path) -> None:
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE_HZ)
        output.writeframes(bytes(SAMPLE_RATE_HZ * SAMPLE_DURATION_SECONDS * 2))


def _consume_gpu_inference(model: WhisperModelPort, source: Path) -> None:
    segments, _info = model.transcribe(
        str(source),
        beam_size=1,
        condition_on_previous_text=False,
        language="en",
        log_progress=False,
        vad_filter=False,
        word_timestamps=False,
    )
    for _ in segments:
        pass


def run_gpu_probe(
    settings: CloudRunProbeEnvironment,
    *,
    ports: ProbePorts = DEFAULT_PROBE_PORTS,
) -> None:
    """Load the baked model and force one content-free inference on exactly one GPU."""
    try:
        device_count = ports.cuda_device_count()
    except Exception:  # noqa: BLE001 - normalize the untyped native library boundary.
        raise CloudRunGpuProbeError(CUDA_DEVICE_INVALID) from None
    if device_count != 1:
        raise CloudRunGpuProbeError(CUDA_DEVICE_INVALID)

    try:
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-cloud-run-gpu-probe-",
            dir=ports.temporary_root,
        ) as task_directory:
            source = Path(task_directory) / "synthetic.wav"
            _write_synthetic_audio(source)
            model = ports.model_factory(settings.model_path)
            _consume_gpu_inference(model, source)
    except Exception:  # noqa: BLE001 - never expose native or filesystem exception details.
        raise CloudRunGpuProbeError(INFERENCE_FAILED) from None


def main(environment: Mapping[str, str] | None = None) -> None:
    """Run once and emit only a stable terminal marker before the container exits."""
    try:
        settings = load_probe_environment(os.environ if environment is None else environment)
        run_gpu_probe(settings)
    except CloudRunGpuProbeError as failure:
        sys.stderr.write(f"{GPU_PROBE_FAILED}:{failure.code}\n")
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - prevent accidental identifier or secret disclosure.
        sys.stderr.write(f"{GPU_PROBE_FAILED}:INTERNAL_ERROR\n")
        raise SystemExit(1) from None
    sys.stdout.write(GPU_PROBE_OK)


if __name__ == "__main__":
    main()
