"""Local native quality gate for the bounded transcription core."""

from __future__ import annotations

import importlib
import math
import sys
import tempfile
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, Protocol, cast

from .bounded_contracts import ExecutionOptionsV2
from .bounded_decoder import FfmpegFloat32Stream, decode_pcm_windows
from .bounded_inference import (
    BEAM_SIZE,
    BoundedInferenceCoordinator,
    WindowTranscriptionInfo,
)
from .bounded_transcription import (
    CORE_SECONDS,
    MAX_RAW_SEGMENTS_PER_WINDOW,
    PromptTail,
    RawWindowSegment,
    SegmentSpool,
    WindowSegmentMerger,
)
from .cloud_run_bounded_gpu_benchmark import NativeArrayWhisperPort, NumpyWindowWhisperModel
from .constants import DEFAULT_MODEL_PATH
from .contracts import TranscriptSegment
from .media import FfprobeMediaProbe, MediaInfo
from .model_bundle import verify_model_bundle
from .speech_quality_fixture import (
    FIXTURE_DURATION_SECONDS,
    SpeechInterval,
    SpeechQualityFixture,
    SpeechQualityFixtureError,
    generate_speech_quality_fixture,
)

QUALITY_CHECK_OK: Final = "bounded-quality-check:ok"
QUALITY_CHECK_FAILED: Final = "bounded-quality-check:failed"
MIN_LANGUAGE_PROBABILITY: Final = 0.5
MIN_GLOBAL_CHARACTERS: Final = 24
MIN_BOUNDARY_CHARACTERS: Final = 12
MAX_GLOBAL_ERROR_RATE: Final = 0.05
MAX_BOUNDARY_ERROR_RATE: Final = 0.10
MAX_NORMALIZED_CHARACTERS: Final = 64 * 1024
MAX_ERROR_RATE_PPM: Final = 1_000_000
EXPECTED_SPEECH_INTERVALS: Final = 3
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - reviewed ephemeral root.

QualityErrorCode = Literal[
    "CANDIDATE_FAILED",
    "CLEANUP_FAILED",
    "FIXTURE_FAILED",
    "MODEL_FAILED",
    "QUALITY_REJECTED",
    "REFERENCE_FAILED",
]
CANDIDATE_FAILED: Final[QualityErrorCode] = "CANDIDATE_FAILED"
CLEANUP_FAILED: Final[QualityErrorCode] = "CLEANUP_FAILED"
FIXTURE_FAILED: Final[QualityErrorCode] = "FIXTURE_FAILED"
MODEL_FAILED: Final[QualityErrorCode] = "MODEL_FAILED"
QUALITY_REJECTED: Final[QualityErrorCode] = "QUALITY_REJECTED"
REFERENCE_FAILED: Final[QualityErrorCode] = "REFERENCE_FAILED"


class BoundedQualityCheckError(Exception):
    """Allowlisted quality failure without transcript or native details."""

    def __init__(self, code: QualityErrorCode, *, metrics: QualityMetrics | None = None) -> None:
        """Retain only a stable code."""
        super().__init__(code)
        self.code = code
        self.metrics = metrics


class QualityWhisperModelPort(Protocol):
    """Native model surface shared by reference path and ndarray adapter."""

    def transcribe(
        self,
        audio: object,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Transcribe one path or one bounded ndarray."""


@dataclass(frozen=True, slots=True)
class QualityTranscript:
    """In-memory comparison value that is never serialized or logged."""

    language: str
    language_probability: float
    duration_seconds: float
    segments: tuple[TranscriptSegment, ...]


@dataclass(frozen=True, slots=True)
class QualityMetrics:
    """Allowlisted numeric evidence with no transcript content."""

    global_error_rate: float
    boundary_error_rate: float
    reference_characters: int
    candidate_characters: int
    reference_boundary_characters: int
    candidate_boundary_characters: int
    reference_segments: int
    candidate_segments: int


ModelFactory = Callable[[str], QualityWhisperModelPort]
FixtureFactory = Callable[[Path], SpeechQualityFixture]
ReferenceRunner = Callable[[QualityWhisperModelPort, Path, float], QualityTranscript]
CandidateRunner = Callable[
    [QualityWhisperModelPort, Path, MediaInfo, Path],
    QualityTranscript,
]
MediaProbe = Callable[[Path, float], MediaInfo]


def _create_gpu_model(model_path: str) -> QualityWhisperModelPort:
    """Load the fixed model with the production CUDA/float16 settings."""
    path = Path(model_path)
    try:
        verify_model_bundle(path)
        module = importlib.import_module("faster_whisper")
        constructor = cast("Callable[..., QualityWhisperModelPort]", module.WhisperModel)
        return constructor(
            model_path,
            device="cuda",
            compute_type="float16",
            local_files_only=True,
            num_workers=1,
        )
    except Exception:  # noqa: BLE001 - normalize model loader and native boundary.
        raise BoundedQualityCheckError(MODEL_FAILED) from None


def _probe_media(source: Path, max_duration_seconds: float) -> MediaInfo:
    return FfprobeMediaProbe().probe(source, max_duration_seconds=max_duration_seconds)


def _default_reference_runner(
    model: QualityWhisperModelPort,
    source: Path,
    duration_seconds: float,
) -> QualityTranscript:
    return run_full_file_reference(model, source, duration_seconds)


def _default_candidate_runner(
    model: QualityWhisperModelPort,
    source: Path,
    media: MediaInfo,
    task_directory: Path,
) -> QualityTranscript:
    return run_bounded_candidate(model, source, media, task_directory)


@dataclass(frozen=True, slots=True)
class QualityCheckPorts:
    """Replaceable boundaries for deterministic unit tests and one local native run."""

    model_factory: ModelFactory = _create_gpu_model
    fixture_factory: FixtureFactory = generate_speech_quality_fixture
    reference_runner: ReferenceRunner = _default_reference_runner
    candidate_runner: CandidateRunner = _default_candidate_runner
    media_probe: MediaProbe = _probe_media
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT


DEFAULT_QUALITY_CHECK_PORTS: Final = QualityCheckPorts()


def create_quality_options() -> ExecutionOptionsV2:
    """Return the exact auto-language, VAD-enabled comparison snapshot."""
    return ExecutionOptionsV2.model_validate(
        {
            "contractVersion": 2,
            "language": "auto",
            "model": "large-v3-turbo",
            "outputFormats": ("json",),
            "vad": True,
        }
    )


def run_full_file_reference(
    model: QualityWhisperModelPort,
    source: Path,
    duration_seconds: float,
) -> QualityTranscript:
    """Run the current full-file inference once as a comparison oracle."""
    try:
        raw_segments, raw_info = model.transcribe(
            str(source),
            beam_size=BEAM_SIZE,
            condition_on_previous_text=True,
            language=None,
            log_progress=False,
            vad_filter=True,
            word_timestamps=False,
        )
        info = WindowTranscriptionInfo.model_validate(raw_info, from_attributes=True)
        segments = _validate_reference_segments(raw_segments)
        return QualityTranscript(
            language=info.language,
            language_probability=info.language_probability,
            duration_seconds=duration_seconds,
            segments=segments,
        )
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize lazy native iterator details.
        raise BoundedQualityCheckError(REFERENCE_FAILED) from None


def _validate_reference_segments(
    raw_segments: Iterable[object],
) -> tuple[TranscriptSegment, ...]:
    segments: list[TranscriptSegment] = []
    previous_order: tuple[float, float, float, int] | None = None
    for raw in raw_segments:
        if len(segments) >= MAX_RAW_SEGMENTS_PER_WINDOW:
            raise BoundedQualityCheckError(REFERENCE_FAILED)
        try:
            parsed = RawWindowSegment.model_validate(raw, from_attributes=True)
        except ValueError:
            raise BoundedQualityCheckError(REFERENCE_FAILED) from None
        midpoint = (parsed.start + parsed.end) / 2
        order = (midpoint, parsed.start, parsed.end, parsed.id)
        if previous_order is not None and order < previous_order:
            raise BoundedQualityCheckError(REFERENCE_FAILED)
        previous_order = order
        segments.append(
            TranscriptSegment(
                id=len(segments),
                start=parsed.start,
                end=parsed.end,
                text=parsed.text,
            )
        )
    return tuple(segments)


def run_bounded_candidate(
    model: QualityWhisperModelPort,
    source: Path,
    media: MediaInfo,
    task_directory: Path,
) -> QualityTranscript:
    """Run the bounded decoder and inference path once with the same model."""
    try:
        prompt = PromptTail()
        with SegmentSpool(task_directory) as spool:
            coordinator = BoundedInferenceCoordinator(
                model=NumpyWindowWhisperModel(cast("NativeArrayWhisperPort", model)),
                options=create_quality_options(),
                merger=WindowSegmentMerger(spool, prompt),
                prompt=prompt,
            )
            stream = FfmpegFloat32Stream(source, audio_stream_index=media.audio_stream_index)
            decode = decode_pcm_windows(stream, coordinator.consume)
            language = coordinator.language_result
            segments = tuple(spool.iter_segments())
        return QualityTranscript(
            language=language.language,
            language_probability=language.probability,
            duration_seconds=decode.duration_seconds,
            segments=segments,
        )
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize decoder, model, and spool details.
        raise BoundedQualityCheckError(CANDIDATE_FAILED) from None


def run_bounded_quality_check(
    *,
    ports: QualityCheckPorts = DEFAULT_QUALITY_CHECK_PORTS,
) -> QualityMetrics:
    """Generate, compare exactly once, cleanup, and return only numeric evidence."""
    task_directory_path: Path | None = None
    result: QualityMetrics | None = None
    try:
        with tempfile.TemporaryDirectory(
            prefix="scribe-drop-bounded-quality-",
            dir=ports.temporary_root,
        ) as task_directory_value:
            task_directory_path = Path(task_directory_value)
            result = _execute_quality_check(ports, task_directory_path)
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize scratch and cleanup details.
        raise BoundedQualityCheckError(CLEANUP_FAILED) from None
    if task_directory_path is None or task_directory_path.exists():
        raise BoundedQualityCheckError(CLEANUP_FAILED)
    if result is None:  # pragma: no cover - defensive invariant after successful context exit.
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    return result


def _execute_quality_check(ports: QualityCheckPorts, task_directory: Path) -> QualityMetrics:
    # Fail before fixture synthesis when CUDA or the fixed model is unavailable.
    model = _load_quality_model(ports)
    fixture, media = _create_fixture_and_media(ports, task_directory)
    reference = _run_reference(ports, model, fixture, media.duration_seconds)
    candidate = _run_candidate(ports, model, fixture, media, task_directory)
    return evaluate_quality(reference, candidate, fixture.speech_intervals)


def _create_fixture_and_media(
    ports: QualityCheckPorts,
    task_directory: Path,
) -> tuple[SpeechQualityFixture, MediaInfo]:
    try:
        fixture = ports.fixture_factory(task_directory)
    except Exception:  # noqa: BLE001 - normalize replaceable fixture boundary.
        raise BoundedQualityCheckError(FIXTURE_FAILED) from None
    _validate_fixture_metadata(fixture, task_directory)
    try:
        media = ports.media_probe(fixture.path, FIXTURE_DURATION_SECONDS)
    except Exception:  # noqa: BLE001 - normalize ffprobe details.
        raise BoundedQualityCheckError(FIXTURE_FAILED) from None
    _validate_fixture_duration(media.duration_seconds)
    return fixture, media


def _validate_fixture_duration(duration_seconds: float) -> None:
    if not math.isclose(
        duration_seconds,
        FIXTURE_DURATION_SECONDS,
        rel_tol=0,
        abs_tol=1 / 1000,
    ):
        raise BoundedQualityCheckError(FIXTURE_FAILED)


def _load_quality_model(ports: QualityCheckPorts) -> QualityWhisperModelPort:
    try:
        return ports.model_factory(DEFAULT_MODEL_PATH)
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize model details.
        raise BoundedQualityCheckError(MODEL_FAILED) from None


def _run_reference(
    ports: QualityCheckPorts,
    model: QualityWhisperModelPort,
    fixture: SpeechQualityFixture,
    duration_seconds: float,
) -> QualityTranscript:
    try:
        return ports.reference_runner(model, fixture.path, duration_seconds)
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize comparison oracle details.
        raise BoundedQualityCheckError(REFERENCE_FAILED) from None


def _run_candidate(
    ports: QualityCheckPorts,
    model: QualityWhisperModelPort,
    fixture: SpeechQualityFixture,
    media: MediaInfo,
    task_directory: Path,
) -> QualityTranscript:
    try:
        return ports.candidate_runner(model, fixture.path, media, task_directory)
    except BoundedQualityCheckError:
        raise
    except Exception:  # noqa: BLE001 - normalize candidate details.
        raise BoundedQualityCheckError(CANDIDATE_FAILED) from None


def _validate_fixture_metadata(fixture: SpeechQualityFixture, task_directory: Path) -> None:
    if (
        fixture.duration_seconds != FIXTURE_DURATION_SECONDS
        or fixture.path != task_directory / "speech-quality.wav"
        or fixture.path.is_symlink()
        or not fixture.path.is_file()
        or len(fixture.speech_intervals) != EXPECTED_SPEECH_INTERVALS
    ):
        raise BoundedQualityCheckError(FIXTURE_FAILED)
    try:
        _ = fixture.boundary_interval
    except SpeechQualityFixtureError:
        raise BoundedQualityCheckError(FIXTURE_FAILED) from None


def evaluate_quality(
    reference: QualityTranscript,
    candidate: QualityTranscript,
    speech_intervals: tuple[SpeechInterval, ...],
) -> QualityMetrics:
    """Apply pre-registered quality thresholds without returning either transcript."""
    # The oracle mirrors the current full-file adapter, which validates native
    # timestamps but does not reject model padding beyond the probed duration.
    # Only the bounded candidate is required to satisfy the strict media bound.
    _validate_transcript(reference, enforce_media_bounds=False)
    _validate_transcript(candidate, enforce_media_bounds=True)
    if (
        reference.language != "ja"
        or candidate.language != "ja"
        or reference.language_probability < MIN_LANGUAGE_PROBABILITY
        or candidate.language_probability < MIN_LANGUAGE_PROBABILITY
        or not math.isclose(
            reference.duration_seconds,
            candidate.duration_seconds,
            rel_tol=0,
            abs_tol=1 / 1000,
        )
    ):
        raise BoundedQualityCheckError(QUALITY_REJECTED)

    reference_global = normalize_segments(reference.segments)
    candidate_global = normalize_segments(candidate.segments)
    boundary_index = _boundary_interval_index(speech_intervals)
    reference_boundary = normalize_assigned_interval(
        reference.segments,
        speech_intervals=speech_intervals,
        target_index=boundary_index,
    )
    candidate_boundary = normalize_assigned_interval(
        candidate.segments,
        speech_intervals=speech_intervals,
        target_index=boundary_index,
    )
    if (
        len(reference_global) < MIN_GLOBAL_CHARACTERS
        or len(candidate_global) < MIN_GLOBAL_CHARACTERS
        or len(reference_boundary) < MIN_BOUNDARY_CHARACTERS
        or len(candidate_boundary) < MIN_BOUNDARY_CHARACTERS
    ):
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    global_rate = character_error_rate(reference_global, candidate_global)
    boundary_rate = character_error_rate(reference_boundary, candidate_boundary)
    metrics = QualityMetrics(
        global_error_rate=global_rate,
        boundary_error_rate=boundary_rate,
        reference_characters=len(reference_global),
        candidate_characters=len(candidate_global),
        reference_boundary_characters=len(reference_boundary),
        candidate_boundary_characters=len(candidate_boundary),
        reference_segments=len(reference.segments),
        candidate_segments=len(candidate.segments),
    )
    if global_rate > MAX_GLOBAL_ERROR_RATE or boundary_rate > MAX_BOUNDARY_ERROR_RATE:
        raise BoundedQualityCheckError(QUALITY_REJECTED, metrics=metrics)
    return metrics


def _boundary_interval_index(speech_intervals: tuple[SpeechInterval, ...]) -> int:
    matches = tuple(
        index
        for index, interval in enumerate(speech_intervals)
        if interval.start_seconds < CORE_SECONDS < interval.end_seconds
    )
    if len(speech_intervals) != EXPECTED_SPEECH_INTERVALS or len(matches) != 1:
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    return matches[0]


def normalize_assigned_interval(
    segments: tuple[TranscriptSegment, ...],
    *,
    speech_intervals: tuple[SpeechInterval, ...],
    target_index: int,
) -> str:
    """Normalize segments assigned to the known speech interval with maximum overlap."""
    if not 0 <= target_index < len(speech_intervals):
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    assigned: list[TranscriptSegment] = []
    for segment in segments:
        overlaps = tuple(
            max(
                0.0,
                min(segment.end, interval.end_seconds) - max(segment.start, interval.start_seconds),
            )
            for interval in speech_intervals
        )
        maximum_overlap = max(overlaps, default=0.0)
        if maximum_overlap > 0 and overlaps.index(maximum_overlap) == target_index:
            assigned.append(segment)
    return normalize_segments(tuple(assigned))


def _validate_transcript(
    transcript: QualityTranscript,
    *,
    enforce_media_bounds: bool,
) -> None:
    if (
        not math.isfinite(transcript.language_probability)
        or not 0 <= transcript.language_probability <= 1
        or not math.isfinite(transcript.duration_seconds)
        or transcript.duration_seconds <= 0
    ):
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    previous_order: tuple[float, float, float, int] | None = None
    for expected_id, segment in enumerate(transcript.segments):
        if segment.id != expected_id or (
            enforce_media_bounds and segment.end > transcript.duration_seconds
        ):
            raise BoundedQualityCheckError(QUALITY_REJECTED)
        midpoint = (segment.start + segment.end) / 2
        order = (midpoint, segment.start, segment.end, segment.id)
        if previous_order is not None and order < previous_order:
            raise BoundedQualityCheckError(QUALITY_REJECTED)
        previous_order = order


def normalize_segments(
    segments: tuple[TranscriptSegment, ...],
    *,
    interval: SpeechInterval | None = None,
) -> str:
    """Return a bounded, punctuation-insensitive comparison value."""
    selected = (
        segment
        for segment in segments
        if interval is None
        or (segment.end > interval.start_seconds and segment.start < interval.end_seconds)
    )
    normalized = unicodedata.normalize("NFKC", "".join(segment.text for segment in selected))
    value = "".join(
        character
        for character in normalized.casefold()
        if unicodedata.category(character)[0] in {"L", "M", "N"}
    )
    if len(value) > MAX_NORMALIZED_CHARACTERS:
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    return value


def character_error_rate(reference: str, candidate: str) -> float:
    """Calculate bounded Levenshtein distance divided by reference length."""
    if not reference or len(reference) > MAX_NORMALIZED_CHARACTERS:
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    if len(candidate) > MAX_NORMALIZED_CHARACTERS:
        raise BoundedQualityCheckError(QUALITY_REJECTED)
    if len(candidate) < len(reference):
        rows, columns = reference, candidate
    else:
        rows, columns = candidate, reference
    previous = list(range(len(columns) + 1))
    for row_index, row_character in enumerate(rows, start=1):
        current = [row_index]
        for column_index, column_character in enumerate(columns, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column_index] + 1,
                    previous[column_index - 1] + (row_character != column_character),
                )
            )
        previous = current
    return previous[-1] / len(reference)


def _metrics_fields(metrics: QualityMetrics) -> str:
    global_ppm = round(metrics.global_error_rate * MAX_ERROR_RATE_PPM)
    boundary_ppm = round(metrics.boundary_error_rate * MAX_ERROR_RATE_PPM)
    return (
        f" global_error_ppm={global_ppm}"
        f" boundary_error_ppm={boundary_ppm}"
        f" reference_characters={metrics.reference_characters}"
        f" candidate_characters={metrics.candidate_characters}"
        f" reference_boundary_characters={metrics.reference_boundary_characters}"
        f" candidate_boundary_characters={metrics.candidate_boundary_characters}"
        f" reference_segments={metrics.reference_segments}"
        f" candidate_segments={metrics.candidate_segments}"
    )


def _metrics_line(metrics: QualityMetrics) -> str:
    return f"{QUALITY_CHECK_OK}{_metrics_fields(metrics)}\n"


def _failure_line(failure: BoundedQualityCheckError) -> str:
    fields = "" if failure.metrics is None else _metrics_fields(failure.metrics)
    return f"{QUALITY_CHECK_FAILED}:{failure.code}{fields}\n"


def main() -> None:
    """Run once and emit only safe terminal evidence."""
    try:
        metrics = run_bounded_quality_check()
    except BoundedQualityCheckError as failure:
        sys.stderr.write(_failure_line(failure))
        raise SystemExit(1) from None
    except Exception:  # noqa: BLE001 - prevent transcript or native detail disclosure.
        sys.stderr.write(f"{QUALITY_CHECK_FAILED}:CLEANUP_FAILED\n")
        raise SystemExit(1) from None
    sys.stdout.write(_metrics_line(metrics))


if __name__ == "__main__":
    main()


__all__ = [
    "BoundedQualityCheckError",
    "QualityCheckPorts",
    "QualityMetrics",
    "QualityTranscript",
    "character_error_rate",
    "create_quality_options",
    "evaluate_quality",
    "normalize_assigned_interval",
    "normalize_segments",
    "run_bounded_quality_check",
]
