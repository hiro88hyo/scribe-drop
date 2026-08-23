"""Sequential Whisper window coordination for the isolated bounded core."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol

from pydantic import Field

from .bounded_transcription import CONTEXT_SAMPLES, RawWindowSegment
from .contracts import LanguageCode, StrictModel
from .errors import WorkerError

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator

    from .bounded_contracts import ExecutionOptionsV2
    from .bounded_decoder import PcmWindow
    from .bounded_transcription import PromptTail, WindowSegmentMerger

TRANSCRIPTION_FAILED: Final = "TRANSCRIPTION_FAILED"
BEAM_SIZE: Final = 5


class WindowWhisperModelPort(Protocol):
    """Subset of one already-loaded Whisper model used by each PCM window."""

    def transcribe(
        self,
        audio: memoryview,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Return a lazy segment iterator and untrusted metadata."""


class WindowTranscriptionInfo(StrictModel):
    """Selected model metadata after explicit third-party field mapping."""

    language: LanguageCode
    language_probability: float = Field(ge=0, le=1)


@dataclass(frozen=True, slots=True)
class InferenceLanguageResult:
    """Detected or fixed language bound to the whole execution."""

    language: str
    probability: float


class BoundedInferenceCoordinator:
    """Call one model sequentially and merge every window into one spool."""

    def __init__(
        self,
        *,
        model: WindowWhisperModelPort,
        options: ExecutionOptionsV2,
        merger: WindowSegmentMerger,
        prompt: PromptTail,
        on_segment: Callable[[], None] | None = None,
    ) -> None:
        """Bind one immutable option snapshot and one model instance."""
        self._model = model
        self._options = options
        self._merger = merger
        self._prompt = prompt
        self._on_segment = on_segment
        self._language_result: InferenceLanguageResult | None = None
        self._window_count = 0

    @property
    def window_count(self) -> int:
        """Return the number of successfully merged inference windows."""
        return self._window_count

    @property
    def language_result(self) -> InferenceLanguageResult:
        """Return the execution language after at least one successful window."""
        if self._language_result is None:
            raise WorkerError(TRANSCRIPTION_FAILED)
        return self._language_result

    def consume(self, window: PcmWindow) -> None:
        """Infer and merge one ephemeral PCM window synchronously."""
        try:
            requested_language = self._requested_language()
            raw_segments, raw_info = self._model.transcribe(
                window.pcm,
                beam_size=BEAM_SIZE,
                condition_on_previous_text=True,
                initial_prompt=self._initial_prompt(window),
                language=requested_language,
                log_progress=False,
                vad_filter=self._options.vad,
                word_timestamps=False,
            )
            info = _validate_info(raw_info)
            self._bind_language(info, requested_language=requested_language)
            self._merger.merge(
                window.spec,
                _validated_segments(raw_segments),
                on_segment=self._on_segment,
            )
            self._window_count += 1
        except WorkerError:
            raise
        except Exception:  # noqa: BLE001 - normalize the lazy native model boundary.
            raise WorkerError(TRANSCRIPTION_FAILED) from None

    def _initial_prompt(self, window: PcmWindow) -> str | None:
        """Avoid duplicating prompt text when EOF expands the acoustic lookbehind."""
        standard_start = max(0, window.spec.core_start_sample - CONTEXT_SAMPLES)
        if window.spec.window_start_sample < standard_start:
            return None
        return self._prompt.value or None

    def _requested_language(self) -> str | None:
        if self._options.language != "auto":
            return self._options.language
        language_result = self._language_result
        return None if language_result is None else language_result.language

    def _bind_language(
        self,
        info: WindowTranscriptionInfo,
        *,
        requested_language: str | None,
    ) -> None:
        if requested_language is not None and info.language != requested_language:
            raise WorkerError(TRANSCRIPTION_FAILED)
        if self._language_result is None:
            self._language_result = InferenceLanguageResult(
                language=info.language,
                probability=info.language_probability,
            )
        elif info.language != self._language_result.language:
            raise WorkerError(TRANSCRIPTION_FAILED)


def _validate_info(value: object) -> WindowTranscriptionInfo:
    try:
        return WindowTranscriptionInfo.model_validate(value, from_attributes=True)
    except ValueError:
        raise WorkerError(TRANSCRIPTION_FAILED) from None


def _validated_segments(values: Iterable[object]) -> Iterator[RawWindowSegment]:
    for value in values:
        try:
            yield RawWindowSegment.model_validate(value, from_attributes=True)
        except ValueError:
            raise WorkerError(TRANSCRIPTION_FAILED) from None


__all__ = [
    "BEAM_SIZE",
    "BoundedInferenceCoordinator",
    "InferenceLanguageResult",
    "WindowTranscriptionInfo",
    "WindowWhisperModelPort",
]
