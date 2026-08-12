"""Network-free full-scan benchmark for the maximum supported audio duration."""

from __future__ import annotations

import importlib
import os
import struct
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .constants import DEFAULT_MODEL_PATH, MAX_DURATION_SECONDS
from .transcription import ModelFactory, WhisperModelPort, create_faster_whisper_model

GPU_BENCHMARK_OK: Final = "cloud-run-gpu-benchmark:ok\n"
GPU_BENCHMARK_FAILED: Final = "cloud-run-gpu-benchmark:failed"
SAMPLE_RATE_HZ: Final = 16_000
CHANNEL_COUNT: Final = 1
SAMPLE_WIDTH_BYTES: Final = 2
PCM_FORMAT_CODE: Final = 1
WAVE_HEADER_SIZE: Final = 44
MAX_UINT32: Final = (1 << 32) - 1
BENCHMARK_ENVIRONMENT_KEYS: Final = (
    "CLOUD_RUN_EXECUTION",
    "CLOUD_RUN_JOB",
    "CLOUD_RUN_TASK_ATTEMPT",
    "CLOUD_RUN_TASK_COUNT",
    "CLOUD_RUN_TASK_INDEX",
    "MODEL_PATH",
)

BenchmarkErrorCode = Literal[
    "CUDA_DEVICE_INVALID",
    "ENVIRONMENT_INVALID",
    "INFERENCE_FAILED",
    "INTERNAL_ERROR",
    "MEDIA_GENERATION_FAILED",
]
CUDA_DEVICE_INVALID: Final[BenchmarkErrorCode] = "CUDA_DEVICE_INVALID"
ENVIRONMENT_INVALID: Final[BenchmarkErrorCode] = "ENVIRONMENT_INVALID"
INFERENCE_FAILED: Final[BenchmarkErrorCode] = "INFERENCE_FAILED"
MEDIA_GENERATION_FAILED: Final[BenchmarkErrorCode] = "MEDIA_GENERATION_FAILED"
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - mandated container scratch root.
CudaDeviceCount = Callable[[], int]
SyntheticAudioFactory = Callable[[Path, int], None]


class CloudRunGpuBenchmarkError(Exception):
    """Allowlisted benchmark failure that is safe to emit to Cloud Logging."""

    def __init__(self, code: BenchmarkErrorCode) -> None:
        """Discard upstream details and retain only a stable error code."""
        super().__init__(code)
        self.code = code


class CloudRunBenchmarkEnvironment(BaseModel):
    """Exact Cloud Run execution boundary permitted by the throughput benchmark."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    execution: str = Field(
        alias="CLOUD_RUN_EXECUTION",
        min_length=30,
        max_length=63,
        pattern=r"^scribe-drop-gpu-benchmark-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    )
    job: Literal["scribe-drop-gpu-benchmark"] = Field(alias="CLOUD_RUN_JOB")
    task_attempt: Literal["0"] = Field(alias="CLOUD_RUN_TASK_ATTEMPT")
    task_count: Literal["1"] = Field(alias="CLOUD_RUN_TASK_COUNT")
    task_index: Literal["0"] = Field(alias="CLOUD_RUN_TASK_INDEX")
    model_path: Literal["/opt/models/large-v3-turbo"] = Field(alias="MODEL_PATH")


def _read_cuda_device_count() -> int:
    module = importlib.import_module("ctranslate2")
    counter = cast("CudaDeviceCount", module.get_cuda_device_count)
    return counter()


def write_sparse_pcm_wave(destination: Path, duration_seconds: int) -> None:
    """Create a valid maximum-duration WAV without allocating its zero-filled data pages."""
    if duration_seconds <= 0 or duration_seconds > MAX_DURATION_SECONDS:
        raise ValueError
    frame_count = SAMPLE_RATE_HZ * duration_seconds
    block_align = CHANNEL_COUNT * SAMPLE_WIDTH_BYTES
    byte_rate = SAMPLE_RATE_HZ * block_align
    data_size = frame_count * block_align
    riff_size = WAVE_HEADER_SIZE - 8 + data_size
    if riff_size > MAX_UINT32:
        raise ValueError
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,
        PCM_FORMAT_CODE,
        CHANNEL_COUNT,
        SAMPLE_RATE_HZ,
        byte_rate,
        block_align,
        SAMPLE_WIDTH_BYTES * 8,
        b"data",
        data_size,
    )
    with destination.open("wb") as output:
        output.write(header)
        output.seek(data_size - 1, os.SEEK_CUR)
        output.write(b"\0")


@dataclass(frozen=True)
class BenchmarkPorts:
    """Replaceable native and filesystem boundaries for the benchmark."""

    cuda_device_count: CudaDeviceCount = _read_cuda_device_count
    model_factory: ModelFactory = create_faster_whisper_model
    audio_factory: SyntheticAudioFactory = write_sparse_pcm_wave
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT
    duration_seconds: int = MAX_DURATION_SECONDS


DEFAULT_BENCHMARK_PORTS: Final = BenchmarkPorts()


def load_benchmark_environment(environment: Mapping[str, str]) -> CloudRunBenchmarkEnvironment:
    """Validate only allowlisted Cloud Run variables without retaining unrelated secrets."""
    selected = {key: environment.get(key) for key in BENCHMARK_ENVIRONMENT_KEYS}
    try:
        return CloudRunBenchmarkEnvironment.model_validate(selected)
    except ValidationError:
        raise CloudRunGpuBenchmarkError(ENVIRONMENT_INVALID) from None


def _consume_full_scan_inference(model: WhisperModelPort, source: Path) -> None:
    segments, _info = model.transcribe(
        str(source),
        beam_size=5,
        condition_on_previous_text=True,
        language=None,
        log_progress=False,
        vad_filter=False,
        word_timestamps=False,
    )
    for _ in segments:
        pass


def run_gpu_benchmark(
    settings: CloudRunBenchmarkEnvironment,
    *,
    ports: BenchmarkPorts = DEFAULT_BENCHMARK_PORTS,
) -> None:
    """Force a maximum-duration full scan on exactly one approved GPU."""
    del settings
    try:
        device_count = ports.cuda_device_count()
    except Exception:  # noqa: BLE001 - normalize the untyped native library boundary.
        raise CloudRunGpuBenchmarkError(CUDA_DEVICE_INVALID) from None
    if device_count != 1:
        raise CloudRunGpuBenchmarkError(CUDA_DEVICE_INVALID)

    try:
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-cloud-run-gpu-benchmark-",
            dir=ports.temporary_root,
        ) as task_directory:
            source = Path(task_directory) / "synthetic-maximum-duration.wav"
            try:
                ports.audio_factory(source, ports.duration_seconds)
            except Exception:  # noqa: BLE001 - normalize the filesystem boundary.
                raise CloudRunGpuBenchmarkError(MEDIA_GENERATION_FAILED) from None
            try:
                model = ports.model_factory(DEFAULT_MODEL_PATH)
                _consume_full_scan_inference(model, source)
            except Exception:  # noqa: BLE001 - never expose native or generated output details.
                raise CloudRunGpuBenchmarkError(INFERENCE_FAILED) from None
    except CloudRunGpuBenchmarkError:
        raise
    except Exception:  # noqa: BLE001 - normalize temporary-directory cleanup failures.
        raise CloudRunGpuBenchmarkError(MEDIA_GENERATION_FAILED) from None


def main(environment: Mapping[str, str] | None = None) -> None:
    """Run once and emit only a stable terminal marker before the container exits."""
    try:
        settings = load_benchmark_environment(os.environ if environment is None else environment)
        run_gpu_benchmark(settings)
    except CloudRunGpuBenchmarkError as failure:
        sys.stderr.write(f"{GPU_BENCHMARK_FAILED}:{failure.code}\n")
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - prevent accidental identifier or secret disclosure.
        sys.stderr.write(f"{GPU_BENCHMARK_FAILED}:INTERNAL_ERROR\n")
        raise SystemExit(1) from None
    sys.stdout.write(GPU_BENCHMARK_OK)


if __name__ == "__main__":
    main()
