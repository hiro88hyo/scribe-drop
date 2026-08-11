"""Tests for the local bounded transcription quality gate."""

from __future__ import annotations

import importlib
from dataclasses import dataclass, replace
from types import SimpleNamespace
from typing import TYPE_CHECKING, Final

import pytest

import scribe_drop_worker.bounded_quality_check as quality_check_module
from scribe_drop_worker.bounded_quality_check import (
    QUALITY_CHECK_FAILED,
    QUALITY_CHECK_OK,
    QUALITY_REJECTED,
    BoundedQualityCheckError,
    QualityCheckPorts,
    QualityMetrics,
    QualityTranscript,
    character_error_rate,
    create_quality_options,
    evaluate_quality,
    main,
    normalize_segments,
    run_bounded_quality_check,
    run_full_file_reference,
)
from scribe_drop_worker.constants import DEFAULT_MODEL_PATH
from scribe_drop_worker.contracts import TranscriptSegment
from scribe_drop_worker.media import MediaInfo
from scribe_drop_worker.speech_quality_fixture import (
    BOUNDARY_SECONDS,
    FIXTURE_DURATION_SECONDS,
    SpeechInterval,
    SpeechQualityFixture,
)

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

BOUNDARY_INTERVAL: Final = SpeechInterval(
    start_sample=(BOUNDARY_SECONDS - 5) * 16_000,
    end_sample=(BOUNDARY_SECONDS + 5) * 16_000,
)
GLOBAL_TEXT: Final = "これは安全な合成文字列です境界の前後を正しく比較します"
BOUNDARY_TEXT: Final = "境界の前後を正しく比較します"
EXPECTED_SEGMENT_COUNT: Final = 3


@dataclass
class NativeSegment:
    """Minimal native segment for the reference adapter."""

    id: int
    start: float
    end: float
    text: str


@dataclass
class NativeInfo:
    """Minimal native language metadata for the reference adapter."""

    language: str
    language_probability: float


class ReferenceModel:
    """Record the full-file options and return deterministic Japanese text."""

    def __init__(self) -> None:
        """Initialize an empty call record."""
        self.calls: list[tuple[object, dict[str, object]]] = []

    def transcribe(
        self,
        audio: object,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Return fixed Japanese segments and metadata."""
        self.calls.append((audio, options))
        return (
            [
                NativeSegment(0, 10, 20, GLOBAL_TEXT),
                NativeSegment(1, 895, 905, BOUNDARY_TEXT),
            ],
            NativeInfo("ja", 0.99),
        )


def _segments(*, boundary_text: str = BOUNDARY_TEXT) -> tuple[TranscriptSegment, ...]:
    return (
        TranscriptSegment(id=0, start=10.0, end=20.0, text=GLOBAL_TEXT),
        TranscriptSegment(id=1, start=895.0, end=905.0, text=boundary_text),
        TranscriptSegment(id=2, start=935.0, end=945.0, text=GLOBAL_TEXT),
    )


def _transcript(
    *,
    language: str = "ja",
    probability: float = 0.99,
    boundary_text: str = BOUNDARY_TEXT,
) -> QualityTranscript:
    return QualityTranscript(
        language=language,
        language_probability=probability,
        duration_seconds=FIXTURE_DURATION_SECONDS,
        segments=_segments(boundary_text=boundary_text),
    )


def _media() -> MediaInfo:
    return MediaInfo(
        audio_codec="pcm_s16le",
        audio_stream_index=0,
        duration_seconds=FIXTURE_DURATION_SECONDS,
        format_name="wav",
        stream_count=1,
    )


def test_quality_options_match_the_pre_registered_native_case() -> None:
    """The native case is auto-language, VAD enabled, and one selected format."""
    options = create_quality_options()
    assert options.language == "auto"
    assert options.vad is True
    assert options.output_formats == ("json",)


def test_native_quality_model_uses_production_gpu_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The native gate cannot silently fall back to CPU inference."""
    calls: list[tuple[str, dict[str, object]]] = []
    expected_model = ReferenceModel()

    def constructor(model_path: str, **options: object) -> ReferenceModel:
        calls.append((model_path, options))
        return expected_model

    monkeypatch.setattr(quality_check_module, "verify_model_bundle", lambda _path: None)
    monkeypatch.setattr(
        importlib,
        "import_module",
        lambda name: (
            SimpleNamespace(WhisperModel=constructor) if name == "faster_whisper" else None
        ),
    )

    model = quality_check_module._create_gpu_model(  # noqa: SLF001 - default factory contract.
        DEFAULT_MODEL_PATH
    )

    assert model is expected_model
    assert calls == [
        (
            DEFAULT_MODEL_PATH,
            {
                "device": "cuda",
                "compute_type": "float16",
                "local_files_only": True,
                "num_workers": 1,
            },
        )
    ]


def test_full_file_reference_uses_exact_options_and_validates_segments(tmp_path: Path) -> None:
    """The oracle runs once without changing the current full-file settings."""
    source = tmp_path / "speech-quality.wav"
    source.write_bytes(b"synthetic")
    model = ReferenceModel()

    result = run_full_file_reference(model, source, FIXTURE_DURATION_SECONDS)

    assert result.language == "ja"
    assert [segment.id for segment in result.segments] == [0, 1]
    assert len(model.calls) == 1
    assert model.calls[0][0] == str(source)
    assert model.calls[0][1] == {
        "beam_size": 5,
        "condition_on_previous_text": True,
        "language": None,
        "log_progress": False,
        "vad_filter": True,
        "word_timestamps": False,
    }


@pytest.mark.parametrize(
    "segments",
    [
        [NativeSegment(0, 20, 10, "invalid")],
        [NativeSegment(0, 0, FIXTURE_DURATION_SECONDS + 1, "invalid")],
        [NativeSegment(1, 10, 11, "later"), NativeSegment(0, 1, 2, "earlier")],
    ],
)
def test_full_file_reference_normalizes_invalid_native_segments(
    tmp_path: Path,
    segments: list[NativeSegment],
) -> None:
    """Malformed lazy model output never leaks native values."""
    source = tmp_path / "speech-quality.wav"
    source.write_bytes(b"synthetic")

    class InvalidModel:
        def transcribe(
            self,
            audio: object,
            **options: object,
        ) -> tuple[Iterable[object], object]:
            del audio, options
            return segments, NativeInfo("ja", 0.9)

    with pytest.raises(BoundedQualityCheckError) as failure:
        run_full_file_reference(InvalidModel(), source, FIXTURE_DURATION_SECONDS)
    assert failure.value.code == "REFERENCE_FAILED"


def test_normalization_removes_spacing_case_and_punctuation_without_exposing_text() -> None:
    """Only letters, marks, and numbers participate in comparison."""
    segments = (
        TranscriptSegment(
            id=0,
            start=895.0,
            end=905.0,
            text=" \uff21bc、 \uff11\uff12! ",
        ),
        TranscriptSegment(id=1, start=920.0, end=921.0, text="outside"),
    )
    assert normalize_segments(segments, interval=BOUNDARY_INTERVAL) == "abc12"


def test_character_error_rate_has_fixed_reference_denominator() -> None:
    """Insertions and deletions are measured against the oracle length."""
    assert character_error_rate("abcd", "abcd") == 0
    assert character_error_rate("abcd", "abc") == pytest.approx(0.25)
    assert character_error_rate("abcd", "abcde") == pytest.approx(0.25)
    with pytest.raises(BoundedQualityCheckError):
        character_error_rate("", "candidate")


def test_quality_evaluation_accepts_equal_transcripts_and_returns_only_metrics() -> None:
    """Matching Japanese output passes the pre-registered global and boundary gates."""
    metrics = evaluate_quality(_transcript(), _transcript(), BOUNDARY_INTERVAL)
    assert metrics.global_error_rate == 0
    assert metrics.boundary_error_rate == 0
    assert metrics.reference_characters == metrics.candidate_characters
    assert metrics.reference_segments == metrics.candidate_segments == EXPECTED_SEGMENT_COUNT


@pytest.mark.parametrize(
    "candidate",
    [
        _transcript(language="en"),
        _transcript(probability=0.49),
        QualityTranscript("ja", 0.9, FIXTURE_DURATION_SECONDS, ()),
        replace(_transcript(), duration_seconds=FIXTURE_DURATION_SECONDS - 1),
        replace(
            _transcript(),
            segments=(
                TranscriptSegment(id=1, start=10, end=20, text=GLOBAL_TEXT),
                *_segments()[1:],
            ),
        ),
        _transcript(boundary_text="まったく異なる長い境界文字列です"),
    ],
)
def test_quality_evaluation_rejects_language_empty_drift_order_and_error(
    candidate: QualityTranscript,
) -> None:
    """Every pre-registered semantic and structural threshold fails closed."""
    with pytest.raises(BoundedQualityCheckError) as failure:
        evaluate_quality(_transcript(), candidate, BOUNDARY_INTERVAL)
    assert failure.value.code == "QUALITY_REJECTED"


def test_quality_runner_uses_one_model_two_paths_and_removes_all_files(tmp_path: Path) -> None:
    """The local gate has one model instance, one fixture, and no retained task data."""
    calls: list[str] = []
    model = ReferenceModel()

    def fixture_factory(task_directory: Path) -> SpeechQualityFixture:
        calls.append("fixture")
        path = task_directory / "speech-quality.wav"
        path.write_bytes(b"synthetic")
        intervals = (
            SpeechInterval(10 * 16_000, 22 * 16_000),
            BOUNDARY_INTERVAL,
            SpeechInterval(930 * 16_000, 942 * 16_000),
        )
        return SpeechQualityFixture(path, FIXTURE_DURATION_SECONDS, intervals)

    def model_factory(path: str) -> ReferenceModel:
        assert path == DEFAULT_MODEL_PATH
        calls.append("model")
        return model

    def reference_runner(
        observed_model: object,
        _source: Path,
        _duration: float,
    ) -> QualityTranscript:
        assert observed_model is model
        calls.append("reference")
        return _transcript()

    def candidate_runner(
        observed_model: object,
        _source: Path,
        _media_info: MediaInfo,
        _task_directory: Path,
    ) -> QualityTranscript:
        assert observed_model is model
        calls.append("candidate")
        return _transcript()

    metrics = run_bounded_quality_check(
        ports=QualityCheckPorts(
            model_factory=model_factory,
            fixture_factory=fixture_factory,
            reference_runner=reference_runner,
            candidate_runner=candidate_runner,
            media_probe=lambda _source, _limit: _media(),
            temporary_root=tmp_path,
        )
    )

    assert metrics.global_error_rate == 0
    assert calls == ["model", "fixture", "reference", "candidate"]
    assert tuple(tmp_path.iterdir()) == ()


@pytest.mark.parametrize(
    ("stage", "expected"),
    [
        ("fixture", "FIXTURE_FAILED"),
        ("media", "FIXTURE_FAILED"),
        ("model", "MODEL_FAILED"),
        ("reference", "REFERENCE_FAILED"),
        ("candidate", "CANDIDATE_FAILED"),
    ],
)
def test_quality_runner_normalizes_port_failures(  # noqa: C901 - shared port-failure matrix.
    tmp_path: Path,
    stage: str,
    expected: str,
) -> None:
    """External port details are reduced to one safe stage code."""

    def fixture_factory(task_directory: Path) -> SpeechQualityFixture:
        path = task_directory / "speech-quality.wav"
        path.write_bytes(b"synthetic")
        return SpeechQualityFixture(
            path,
            FIXTURE_DURATION_SECONDS,
            (
                SpeechInterval(10 * 16_000, 22 * 16_000),
                BOUNDARY_INTERVAL,
                SpeechInterval(930 * 16_000, 942 * 16_000),
            ),
        )

    def model_factory(_path: str) -> ReferenceModel:
        return ReferenceModel()

    def reference_runner(
        _model: object,
        _source: Path,
        _duration: float,
    ) -> QualityTranscript:
        return _transcript()

    def candidate_runner(
        _model: object,
        _source: Path,
        _media_info: MediaInfo,
        _task_directory: Path,
    ) -> QualityTranscript:
        return _transcript()

    def fail_fixture(_task_directory: Path) -> SpeechQualityFixture:
        msg = "secret fixture detail"
        raise RuntimeError(msg)

    def fail_media(_source: Path, _limit: float) -> MediaInfo:
        msg = "secret media detail"
        raise RuntimeError(msg)

    def fail_model(_path: str) -> ReferenceModel:
        msg = "secret model detail"
        raise RuntimeError(msg)

    def fail_reference(
        _model: object,
        _source: Path,
        _duration: float,
    ) -> QualityTranscript:
        msg = "secret reference detail"
        raise RuntimeError(msg)

    def fail_candidate(
        _model: object,
        _source: Path,
        _media_info: MediaInfo,
        _task_directory: Path,
    ) -> QualityTranscript:
        msg = "secret candidate detail"
        raise RuntimeError(msg)

    ports = QualityCheckPorts(
        model_factory=model_factory,
        fixture_factory=fixture_factory,
        reference_runner=reference_runner,
        candidate_runner=candidate_runner,
        media_probe=lambda _source, _limit: _media(),
        temporary_root=tmp_path,
    )
    if stage == "fixture":
        ports = replace(ports, fixture_factory=fail_fixture)
    elif stage == "media":
        ports = replace(ports, media_probe=fail_media)
    elif stage == "model":
        ports = replace(ports, model_factory=fail_model)
    elif stage == "reference":
        ports = replace(ports, reference_runner=fail_reference)
    elif stage == "candidate":
        ports = replace(ports, candidate_runner=fail_candidate)
    with pytest.raises(BoundedQualityCheckError) as failure:
        run_bounded_quality_check(ports=ports)
    assert failure.value.code == expected
    assert "secret" not in str(failure.value)
    assert tuple(tmp_path.iterdir()) == ()


def test_main_emits_only_allowlisted_metrics_or_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Neither successful nor failed terminal output contains transcript text."""
    metrics = QualityMetrics(0.01, 0.02, 100, 101, 20, 21, 3, 3)
    monkeypatch.setattr(
        "scribe_drop_worker.bounded_quality_check.run_bounded_quality_check",
        lambda: metrics,
    )
    main()
    captured = capsys.readouterr()
    assert captured.out.startswith(f"{QUALITY_CHECK_OK} global_error_ppm=10000")
    assert GLOBAL_TEXT not in captured.out
    assert captured.err == ""

    def fail() -> QualityMetrics:
        raise BoundedQualityCheckError(QUALITY_REJECTED)

    monkeypatch.setattr("scribe_drop_worker.bounded_quality_check.run_bounded_quality_check", fail)
    with pytest.raises(SystemExit):
        main()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"{QUALITY_CHECK_FAILED}:QUALITY_REJECTED\n"
