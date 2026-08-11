"""Tests for language, VAD, prompt, and strict native window coordination."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest

from scribe_drop_worker.bounded_contracts import ExecutionOptionsV2
from scribe_drop_worker.bounded_decoder import PcmWindow
from scribe_drop_worker.bounded_inference import BEAM_SIZE, BoundedInferenceCoordinator
from scribe_drop_worker.bounded_transcription import (
    CORE_SAMPLES,
    PCM_BYTES_PER_SAMPLE,
    PromptTail,
    SegmentSpool,
    WindowSegmentMerger,
    plan_windows,
)
from scribe_drop_worker.errors import WorkerError

if TYPE_CHECKING:
    from pathlib import Path

EXPECTED_TWO_WINDOWS: Final = 2


@dataclass
class NativeSegment:
    """Minimal object shaped like a faster-whisper segment."""

    id: int
    start: float
    end: float
    text: str


@dataclass
class NativeInfo:
    """Minimal object shaped like faster-whisper metadata."""

    language: str
    language_probability: float


class FakeWindowModel:
    """Record options and return one deterministic segment per window."""

    def __init__(self, languages: tuple[str, ...]) -> None:
        """Set the metadata language returned for each call."""
        self._languages = languages
        self.calls: list[dict[str, object]] = []

    def transcribe(
        self,
        audio: memoryview,
        **options: object,
    ) -> tuple[list[NativeSegment], NativeInfo]:
        """Consume the ephemeral view before returning lazy-compatible results."""
        assert audio.nbytes > 0
        index = len(self.calls)
        self.calls.append(options)
        start = 0.0 if index == 0 else 30.0
        return [NativeSegment(0, start, start + 1.0, f"window {index}")], NativeInfo(
            self._languages[index],
            0.9,
        )


def _options(*, language: str, vad: bool) -> ExecutionOptionsV2:
    return ExecutionOptionsV2.model_validate(
        {
            "contractVersion": 2,
            "language": language,
            "model": "large-v3-turbo",
            "outputFormats": ("json",),
            "vad": vad,
        }
    )


def _pcm_window(index: int, *, total_windows: int = 2) -> PcmWindow:
    windows = plan_windows(total_windows * CORE_SAMPLES)
    spec = windows[index]
    return PcmWindow(
        spec=spec,
        pcm=memoryview(bytes(PCM_BYTES_PER_SAMPLE)),
    )


def test_auto_language_is_detected_once_then_fixed_with_bounded_prompt(tmp_path: Path) -> None:
    """Only the first window uses auto and the second receives accepted prior text."""
    model = FakeWindowModel(("en", "en"))
    prompt = PromptTail()
    with SegmentSpool(tmp_path) as spool:
        coordinator = BoundedInferenceCoordinator(
            model=model,
            options=_options(language="auto", vad=False),
            merger=WindowSegmentMerger(spool, prompt),
            prompt=prompt,
        )
        first = _pcm_window(0)
        second = _pcm_window(1)
        try:
            coordinator.consume(first)
            coordinator.consume(second)
        finally:
            first.pcm.release()
            second.pcm.release()

        assert coordinator.window_count == EXPECTED_TWO_WINDOWS
        assert coordinator.language_result.language == "en"
        assert [row.text for row in spool.iter_segments()] == ["window 0", "window 1"]

    assert model.calls[0] == {
        "beam_size": BEAM_SIZE,
        "condition_on_previous_text": True,
        "initial_prompt": None,
        "language": None,
        "log_progress": False,
        "vad_filter": False,
        "word_timestamps": False,
    }
    assert model.calls[1]["language"] == "en"
    assert model.calls[1]["initial_prompt"] == "window 0"


def test_japanese_and_vad_are_applied_to_every_window(tmp_path: Path) -> None:
    """The fixed Japanese path never silently falls back to auto or disables VAD."""
    model = FakeWindowModel(("ja",))
    prompt = PromptTail()
    with SegmentSpool(tmp_path) as spool:
        coordinator = BoundedInferenceCoordinator(
            model=model,
            options=_options(language="ja", vad=True),
            merger=WindowSegmentMerger(spool, prompt),
            prompt=prompt,
        )
        window = _pcm_window(0, total_windows=1)
        try:
            coordinator.consume(window)
        finally:
            window.pcm.release()

    assert model.calls[0]["language"] == "ja"
    assert model.calls[0]["vad_filter"] is True
    assert coordinator.language_result.language == "ja"


def test_language_drift_and_malformed_native_values_fail_closed(tmp_path: Path) -> None:
    """Model metadata or segment drift cannot be logged or accepted."""
    model = FakeWindowModel(("en", "fr"))
    prompt = PromptTail()
    with SegmentSpool(tmp_path) as spool:
        coordinator = BoundedInferenceCoordinator(
            model=model,
            options=_options(language="auto", vad=True),
            merger=WindowSegmentMerger(spool, prompt),
            prompt=prompt,
        )
        first = _pcm_window(0)
        second = _pcm_window(1)
        try:
            coordinator.consume(first)
            with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
                coordinator.consume(second)
        finally:
            first.pcm.release()
            second.pcm.release()

    class InvalidModel:
        def transcribe(
            self,
            audio: memoryview,
            **options: object,
        ) -> tuple[list[object], object]:
            del audio, options
            return [object()], object()

    other = tmp_path / "other"
    other.mkdir()
    invalid_prompt = PromptTail()
    with SegmentSpool(other) as spool:
        invalid = BoundedInferenceCoordinator(
            model=InvalidModel(),
            options=_options(language="ja", vad=True),
            merger=WindowSegmentMerger(spool, invalid_prompt),
            prompt=invalid_prompt,
        )
        window = _pcm_window(0, total_windows=1)
        try:
            with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
                invalid.consume(window)
        finally:
            window.pcm.release()


def test_language_result_requires_a_successful_window(tmp_path: Path) -> None:
    """No execution language is invented before model metadata is validated."""
    prompt = PromptTail()
    with SegmentSpool(tmp_path) as spool:
        coordinator = BoundedInferenceCoordinator(
            model=FakeWindowModel(("ja",)),
            options=_options(language="ja", vad=True),
            merger=WindowSegmentMerger(spool, prompt),
            prompt=prompt,
        )
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            _ = coordinator.language_result
