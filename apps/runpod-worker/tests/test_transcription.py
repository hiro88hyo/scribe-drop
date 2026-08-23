"""Tests for lazy and fixed faster-whisper execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest

from scribe_drop_worker.errors import WorkerError
from scribe_drop_worker.transcription import (
    FasterWhisperTranscriber,
    create_faster_whisper_model,
)

if TYPE_CHECKING:
    from pathlib import Path

EXPECTED_BEAM_SIZE: Final = 5


@dataclass
class FakeSegment:
    """Minimal third-party segment."""

    id: int
    start: float
    end: float
    text: str


@dataclass
class FakeInfo:
    """Minimal third-party result metadata."""

    language: str
    language_probability: float


class FakeModel:
    """Record fixed transcription options."""

    def __init__(self, result_language: str = "ja") -> None:
        """Initialize observation fields."""
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.result_language = result_language

    def transcribe(self, audio: str, **options: object) -> tuple[list[FakeSegment], FakeInfo]:
        """Return deterministic transcription data."""
        self.calls.append((audio, options))
        return [FakeSegment(0, 0.0, 1.25, "safe text")], FakeInfo(
            self.result_language,
            0.99,
        )


def test_model_is_loaded_lazily_with_fixed_transcription_settings(tmp_path: Path) -> None:
    """Construction performs no model work; transcription loads exactly once."""
    model = FakeModel()
    factory_calls: list[str] = []

    def factory(path: str) -> FakeModel:
        factory_calls.append(path)
        return model

    transcriber = FasterWhisperTranscriber("/opt/models/fixed", model_factory=factory)
    assert factory_calls == []

    callbacks = 0

    def on_segment() -> None:
        nonlocal callbacks
        callbacks += 1

    result = transcriber.transcribe(
        tmp_path / "source.bin",
        duration_seconds=60.0,
        language="auto",
        on_segment=on_segment,
        vad=True,
    )
    assert factory_calls == ["/opt/models/fixed"]
    assert result.language == "ja"
    assert len(result.segments) == 1
    assert callbacks == 1
    assert model.calls[0][1] == {
        "beam_size": EXPECTED_BEAM_SIZE,
        "condition_on_previous_text": True,
        "language": None,
        "log_progress": False,
        "vad_filter": True,
        "word_timestamps": False,
    }


def test_invalid_third_party_output_is_normalized(tmp_path: Path) -> None:
    """Malformed model data cannot escape as raw output."""

    class InvalidModel(FakeModel):
        def transcribe(self, audio: str, **options: object) -> tuple[list[FakeSegment], FakeInfo]:
            del audio, options
            return [FakeSegment(0, 2.0, 1.0, "unsafe")], FakeInfo("invalid-language", 2.0)

    transcriber = FasterWhisperTranscriber(
        "/opt/models/fixed",
        model_factory=lambda _path: InvalidModel(),
    )
    with pytest.raises(WorkerError):
        transcriber.transcribe(
            tmp_path / "source.bin",
            duration_seconds=60.0,
            language="auto",
            vad=True,
        )


def test_english_is_fixed_and_language_drift_is_rejected(tmp_path: Path) -> None:
    """A fixed English snapshot reaches faster-whisper and must match its metadata."""
    model = FakeModel("en")
    transcriber = FasterWhisperTranscriber(
        "/opt/models/fixed",
        model_factory=lambda _path: model,
    )
    result = transcriber.transcribe(
        tmp_path / "source.bin",
        duration_seconds=60.0,
        language="en",
        vad=False,
    )
    assert result.language == "en"
    assert model.calls[0][1]["language"] == "en"
    assert model.calls[0][1]["vad_filter"] is False

    class DriftModel(FakeModel):
        def transcribe(self, audio: str, **options: object) -> tuple[list[FakeSegment], FakeInfo]:
            del audio
            assert options["language"] == "en"
            return [FakeSegment(0, 0.0, 1.25, "safe text")], FakeInfo("ja", 0.99)

    drift = FasterWhisperTranscriber(
        "/opt/models/fixed",
        model_factory=lambda _path: DriftModel(),
    )
    with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED") as failure:
        drift.transcribe(
            tmp_path / "source.bin",
            duration_seconds=60.0,
            language="en",
            vad=True,
        )
    assert failure.value.code == "TRANSCRIPTION_FAILED"


def test_default_model_factory_rejects_incomplete_model_before_import(tmp_path: Path) -> None:
    """Missing fixed model files can never trigger a runtime download."""
    model_path = tmp_path / "model"
    model_path.mkdir()
    (model_path / "config.json").write_text("{}")
    with pytest.raises(WorkerError) as failure:
        create_faster_whisper_model(str(model_path))
    assert failure.value.code == "TRANSCRIPTION_FAILED"
