"""Network-free Cloud Run benchmark entrypoint for the bounded transcription core."""

from __future__ import annotations

import hashlib
import importlib
import os
import sys
import tempfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal, Protocol, cast

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .bounded_artifacts import (
    ArtifactPublicationPlan,
    ArtifactUploadTarget,
    BoundedArtifactPublisher,
    StreamingArtifactUploadPort,
    TranscriptMetadataV2,
)
from .bounded_contracts import ExecutionOptionsV2, OutputFormatV2, ResultManifestV2
from .bounded_decoder import FfmpegFloat32Stream, PcmStream, decode_pcm_windows
from .bounded_inference import BoundedInferenceCoordinator, WindowWhisperModelPort
from .bounded_transcription import PromptTail, SegmentSpool, WindowSegmentMerger
from .cloud_run_gpu_benchmark import SyntheticAudioFactory, write_sparse_pcm_wave
from .constants import DEFAULT_MODEL_PATH, MAX_DURATION_SECONDS
from .media import FfprobeMediaProbe, MediaInfo
from .transcription import create_faster_whisper_model

if TYPE_CHECKING:
    from typing import BinaryIO

    from numpy.typing import NDArray

BOUNDED_BENCHMARK_OK: Final = "cloud-run-bounded-gpu-benchmark:ok\n"
BOUNDED_BENCHMARK_FAILED: Final = "cloud-run-bounded-gpu-benchmark:failed"
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - reviewed scratch mount.
BENCHMARK_JOB_NAME: Final = "scribe-drop-bounded-gpu-benchmark"
BENCHMARK_ENVIRONMENT_KEYS: Final = (
    "CLOUD_RUN_EXECUTION",
    "CLOUD_RUN_JOB",
    "CLOUD_RUN_TASK_ATTEMPT",
    "CLOUD_RUN_TASK_COUNT",
    "CLOUD_RUN_TASK_INDEX",
    "MODEL_PATH",
)
DUMMY_JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
DUMMY_ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
DUMMY_OWNER_HASH: Final = "a" * 32
DUMMY_RESULT_ORIGIN: Final = "https://storage.example.invalid"

BenchmarkErrorCode = Literal[
    "ARTIFACT_FAILED",
    "CUDA_DEVICE_INVALID",
    "ENVIRONMENT_INVALID",
    "INFERENCE_FAILED",
    "INTERNAL_ERROR",
    "MEDIA_GENERATION_FAILED",
]
ARTIFACT_FAILED: Final[BenchmarkErrorCode] = "ARTIFACT_FAILED"
CUDA_DEVICE_INVALID: Final[BenchmarkErrorCode] = "CUDA_DEVICE_INVALID"
ENVIRONMENT_INVALID: Final[BenchmarkErrorCode] = "ENVIRONMENT_INVALID"
INFERENCE_FAILED: Final[BenchmarkErrorCode] = "INFERENCE_FAILED"
MEDIA_GENERATION_FAILED: Final[BenchmarkErrorCode] = "MEDIA_GENERATION_FAILED"


class CloudRunBoundedBenchmarkError(Exception):
    """Allowlisted benchmark failure safe for Cloud Logging."""

    def __init__(self, code: BenchmarkErrorCode) -> None:
        """Retain only a stable code and discard upstream details."""
        super().__init__(code)
        self.code = code


class CloudRunBoundedBenchmarkEnvironment(BaseModel):
    """Exact one-task Cloud Run Job environment accepted by the re-probe image."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    execution: str = Field(
        alias="CLOUD_RUN_EXECUTION",
        min_length=30,
        max_length=63,
        pattern=r"^scribe-drop-bounded-gpu-benchmark-[a-z0-9]"
        r"(?:[a-z0-9-]*[a-z0-9])?$",
    )
    job: Literal["scribe-drop-bounded-gpu-benchmark"] = Field(alias="CLOUD_RUN_JOB")
    task_attempt: Literal["0"] = Field(alias="CLOUD_RUN_TASK_ATTEMPT")
    task_count: Literal["1"] = Field(alias="CLOUD_RUN_TASK_COUNT")
    task_index: Literal["0"] = Field(alias="CLOUD_RUN_TASK_INDEX")
    model_path: Literal["/opt/models/large-v3-turbo"] = Field(alias="MODEL_PATH")


class NativeArrayWhisperPort(Protocol):
    """Actual faster-whisper surface used after zero-copy NumPy conversion."""

    def transcribe(
        self,
        audio: NDArray[np.float32],
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Transcribe one bounded NumPy window."""


NativeModelFactory = Callable[[str], NativeArrayWhisperPort]
CudaDeviceCount = Callable[[], int]
MediaProbe = Callable[[Path, float], MediaInfo]
PcmStreamFactory = Callable[[Path, int], PcmStream]


def _read_cuda_device_count() -> int:
    module = importlib.import_module("ctranslate2")
    counter = cast("CudaDeviceCount", module.get_cuda_device_count)
    return counter()


def _create_native_model(model_path: str) -> NativeArrayWhisperPort:
    model = create_faster_whisper_model(model_path)
    # faster-whisper accepts ndarray at runtime; the legacy v1 port narrows it to path strings.
    return cast("NativeArrayWhisperPort", model)


def _probe_media(source: Path, max_duration_seconds: float) -> MediaInfo:
    return FfprobeMediaProbe().probe(source, max_duration_seconds=max_duration_seconds)


def _create_pcm_stream(source: Path, audio_stream_index: int) -> PcmStream:
    return FfmpegFloat32Stream(source, audio_stream_index=audio_stream_index)


class NumpyWindowWhisperModel(WindowWhisperModelPort):
    """Convert one read-only little-endian float32 view without copying it."""

    def __init__(self, model: NativeArrayWhisperPort) -> None:
        """Bind one already-loaded native model."""
        self._model = model

    def transcribe(
        self,
        audio: memoryview,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Validate frame alignment and delegate one bounded ndarray."""
        if audio.nbytes == 0 or audio.nbytes % np.dtype("<f4").itemsize != 0:
            msg = "PCM float32 alignment invalid"
            raise ValueError(msg)
        samples = np.frombuffer(audio, dtype="<f4")
        if samples.dtype != np.dtype("float32") or not samples.flags.c_contiguous:
            msg = "PCM float32 layout invalid"
            raise ValueError(msg)
        return self._model.transcribe(samples, **options)


class DiscardingArtifactUpload(StreamingArtifactUploadPort):
    """Exercise streaming publication without network or retained transcript bytes."""

    def __init__(self) -> None:
        """Initialize safe counters."""
        self.artifact_count = 0
        self.manifest_written = False

    def put_file(
        self,
        url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Hash and discard one file while validating declared integrity."""
        del url, content_type
        digest = hashlib.sha256()
        observed_size = 0
        while chunk := content.read(1024 * 1024):
            observed_size += len(chunk)
            digest.update(chunk)
        if observed_size != size_bytes or digest.hexdigest() != sha256:
            msg = "artifact integrity mismatch"
            raise ValueError(msg)
        self.artifact_count += 1

    def put_manifest(self, url: str, content: bytes) -> None:
        """Validate and discard the exact completion marker last."""
        del url
        ResultManifestV2.model_validate_json(content)
        self.manifest_written = True


def _require_manifest_written(upload: DiscardingArtifactUpload) -> None:
    """Reject a publication that returned without its completion marker."""
    if not upload.manifest_written:
        raise CloudRunBoundedBenchmarkError(ARTIFACT_FAILED)


@dataclass(frozen=True, slots=True)
class BoundedBenchmarkPorts:
    """Replaceable offline boundaries for local tests and the exact cloud candidate."""

    cuda_device_count: CudaDeviceCount = _read_cuda_device_count
    model_factory: NativeModelFactory = _create_native_model
    audio_factory: SyntheticAudioFactory = write_sparse_pcm_wave
    media_probe: MediaProbe = _probe_media
    pcm_stream_factory: PcmStreamFactory = _create_pcm_stream
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT
    duration_seconds: int = MAX_DURATION_SECONDS


DEFAULT_BOUNDED_BENCHMARK_PORTS: Final = BoundedBenchmarkPorts()


@dataclass(frozen=True, slots=True)
class BoundedBenchmarkResult:
    """Non-sensitive counters used only by local tests and terminal decisions."""

    duration_seconds: float
    window_count: int
    segment_count: int
    artifact_count: int


def load_bounded_benchmark_environment(
    environment: Mapping[str, str],
) -> CloudRunBoundedBenchmarkEnvironment:
    """Validate only allowlisted Cloud Run variables."""
    selected = {key: environment.get(key) for key in BENCHMARK_ENVIRONMENT_KEYS}
    try:
        return CloudRunBoundedBenchmarkEnvironment.model_validate(selected)
    except ValidationError:
        raise CloudRunBoundedBenchmarkError(ENVIRONMENT_INVALID) from None


def run_bounded_gpu_benchmark(
    settings: CloudRunBoundedBenchmarkEnvironment,
    *,
    ports: BoundedBenchmarkPorts = DEFAULT_BOUNDED_BENCHMARK_PORTS,
) -> BoundedBenchmarkResult:
    """Run the same sequential core intended for the one approved L4 re-probe."""
    del settings
    try:
        device_count = ports.cuda_device_count()
    except Exception:  # noqa: BLE001 - normalize native device discovery.
        raise CloudRunBoundedBenchmarkError(CUDA_DEVICE_INVALID) from None
    if device_count != 1:
        raise CloudRunBoundedBenchmarkError(CUDA_DEVICE_INVALID)
    try:
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-cloud-run-bounded-benchmark-",
            dir=ports.temporary_root,
        ) as task_directory_value:
            task_directory = Path(task_directory_value)
            source = task_directory / "synthetic-maximum-duration.wav"
            try:
                ports.audio_factory(source, ports.duration_seconds)
                media = ports.media_probe(source, MAX_DURATION_SECONDS)
            except Exception:  # noqa: BLE001 - normalize source and ffprobe details.
                raise CloudRunBoundedBenchmarkError(MEDIA_GENERATION_FAILED) from None
            try:
                native_model = ports.model_factory(DEFAULT_MODEL_PATH)
                prompt = PromptTail()
                with SegmentSpool(task_directory) as spool:
                    coordinator = BoundedInferenceCoordinator(
                        model=NumpyWindowWhisperModel(native_model),
                        options=create_benchmark_options(),
                        merger=WindowSegmentMerger(spool, prompt),
                        prompt=prompt,
                    )
                    pcm_stream = ports.pcm_stream_factory(source, media.audio_stream_index)
                    decode = decode_pcm_windows(pcm_stream, coordinator.consume)
                    language = coordinator.language_result
                    upload = DiscardingArtifactUpload()
                    try:
                        publication = BoundedArtifactPublisher(task_directory, upload).publish(
                            create_benchmark_publication_plan(
                                language=language.language,
                                language_probability=language.probability,
                                duration_seconds=decode.duration_seconds,
                            ),
                            spool,
                        )
                        _require_manifest_written(upload)
                    except CloudRunBoundedBenchmarkError:
                        raise
                    except Exception:  # noqa: BLE001 - normalize artifact details.
                        raise CloudRunBoundedBenchmarkError(ARTIFACT_FAILED) from None
                    return BoundedBenchmarkResult(
                        duration_seconds=decode.duration_seconds,
                        window_count=decode.window_count,
                        segment_count=spool.segment_count,
                        artifact_count=publication.artifact_count,
                    )
            except CloudRunBoundedBenchmarkError:
                raise
            except Exception:  # noqa: BLE001 - never expose model, PCM, or transcript details.
                raise CloudRunBoundedBenchmarkError(INFERENCE_FAILED) from None
    except CloudRunBoundedBenchmarkError:
        raise
    except Exception:  # noqa: BLE001 - normalize temporary-directory cleanup failures.
        raise CloudRunBoundedBenchmarkError(MEDIA_GENERATION_FAILED) from None


def create_benchmark_options() -> ExecutionOptionsV2:
    """Return the immutable options shared by local and cloud benchmark checks."""
    return ExecutionOptionsV2.model_validate(
        {
            "contractVersion": 2,
            "language": "auto",
            "model": "large-v3-turbo",
            "outputFormats": ("markdown", "json", "srt"),
            "vad": False,
        }
    )


def create_benchmark_publication_plan(
    *,
    language: str,
    language_probability: float,
    duration_seconds: float,
) -> ArtifactPublicationPlan:
    """Build deterministic dummy capabilities for offline artifact exercise."""
    formats = create_benchmark_options().output_formats
    targets = tuple(_artifact_target(format_) for format_ in formats)
    return ArtifactPublicationPlan.model_validate(
        {
            "jobId": DUMMY_JOB_ID,
            "attemptId": DUMMY_ATTEMPT_ID,
            "options": create_benchmark_options(),
            "metadata": TranscriptMetadataV2(
                language=language,
                languageProbability=language_probability,
                durationSeconds=duration_seconds,
            ),
            "targets": targets,
            "manifestPutUrl": f"{DUMMY_RESULT_ORIGIN}/manifest.json?signature=dummy",
        }
    )


def _artifact_target(format_: OutputFormatV2) -> ArtifactUploadTarget:
    extension = {"markdown": "md", "json": "json", "srt": "srt"}[format_]
    key = f"results/{DUMMY_OWNER_HASH}/{DUMMY_JOB_ID}/{DUMMY_ATTEMPT_ID}/transcript.{extension}"
    return ArtifactUploadTarget.model_validate(
        {
            "format": format_,
            "key": key,
            "putUrl": f"{DUMMY_RESULT_ORIGIN}/transcript.{extension}?signature=dummy",
        }
    )


def main(environment: Mapping[str, str] | None = None) -> None:
    """Run once and emit only one allowlisted terminal marker."""
    try:
        settings = load_bounded_benchmark_environment(
            os.environ if environment is None else environment
        )
        run_bounded_gpu_benchmark(settings)
    except CloudRunBoundedBenchmarkError as failure:
        sys.stderr.write(f"{BOUNDED_BENCHMARK_FAILED}:{failure.code}\n")
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - prevent identifier or secret disclosure.
        sys.stderr.write(f"{BOUNDED_BENCHMARK_FAILED}:INTERNAL_ERROR\n")
        raise SystemExit(1) from None
    sys.stdout.write(BOUNDED_BENCHMARK_OK)


if __name__ == "__main__":
    main()
