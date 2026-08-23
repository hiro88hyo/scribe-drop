"""Lazy, offline-only faster-whisper adapter."""

from __future__ import annotations

import importlib
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Final, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field

from .constants import MODEL_NAME
from .contracts import RunpodExecutionLanguage, TranscriptSegment
from .errors import WorkerError

TRANSCRIPTION_FAILED: Final = "TRANSCRIPTION_FAILED"
REQUIRED_MODEL_FILES: Final = frozenset(
    {
        "config.json",
        "model.bin",
        "tokenizer.json",
    }
)


class RawTranscriptionInfo(BaseModel):
    """Validated faster-whisper result metadata."""

    model_config = ConfigDict(extra="ignore", frozen=True, strict=True, from_attributes=True)

    language: str = Field(pattern=r"^[a-z]{2,3}$")
    language_probability: float = Field(ge=0, le=1)


class RawSegment(BaseModel):
    """Validated faster-whisper segment fields."""

    model_config = ConfigDict(extra="ignore", frozen=True, strict=True, from_attributes=True)

    id: int = Field(ge=0)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str


class WhisperModelPort(Protocol):
    """Subset of faster-whisper used by ScribeDrop."""

    def transcribe(
        self,
        audio: str,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        """Transcribe a local source path."""


ModelFactory = Callable[[str], WhisperModelPort]


def create_faster_whisper_model(model_path: str) -> WhisperModelPort:
    """Load only a complete local model directory with fixed GPU settings."""
    path = Path(model_path)
    try:
        valid_model = (
            path.is_absolute()
            and not path.is_symlink()
            and path.is_dir()
            and REQUIRED_MODEL_FILES.issubset(
                child.name for child in path.iterdir() if child.is_file()
            )
        )
    except OSError:
        raise WorkerError(TRANSCRIPTION_FAILED) from None
    if not valid_model:
        raise WorkerError(TRANSCRIPTION_FAILED)
    try:
        module = importlib.import_module("faster_whisper")
        constructor = cast("Callable[..., WhisperModelPort]", module.WhisperModel)
        model = constructor(
            model_path,
            device="cuda",
            compute_type="float16",
            local_files_only=True,
            num_workers=1,
        )
    except Exception:  # noqa: BLE001 - normalize the untyped native library boundary.
        raise WorkerError(TRANSCRIPTION_FAILED) from None
    return model


class TranscriptionResult(BaseModel):
    """Validated transcription used only for artifact construction."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    language: str = Field(pattern=r"^[a-z]{2,3}$")
    language_probability: float = Field(ge=0, le=1)
    duration_seconds: float = Field(gt=0)
    segments: tuple[TranscriptSegment, ...]


class FasterWhisperTranscriber:
    """Load the model lazily, only after claim and media validation."""

    def __init__(
        self,
        model_path: str,
        *,
        model_factory: ModelFactory = create_faster_whisper_model,
    ) -> None:
        """Store the fixed path without loading model memory."""
        self._model_path = model_path
        self._model_factory = model_factory
        self._model: WhisperModelPort | None = None

    def transcribe(
        self,
        source: Path,
        *,
        duration_seconds: float,
        language: RunpodExecutionLanguage,
        on_segment: Callable[[], None] | None = None,
        vad: bool,
    ) -> TranscriptionResult:
        """Transcribe with fixed decoding settings and validate every result segment."""
        try:
            requested_language = None if language == "auto" else language
            segments, raw_info = self._get_model().transcribe(
                str(source),
                beam_size=5,
                condition_on_previous_text=True,
                language=requested_language,
                log_progress=False,
                vad_filter=vad,
                word_timestamps=False,
            )
            info = RawTranscriptionInfo.model_validate(raw_info)
            _require_requested_language(info.language, requested_language)
            validated_segments: list[TranscriptSegment] = []
            for raw_segment in segments:
                segment = RawSegment.model_validate(raw_segment)
                validated_segments.append(
                    TranscriptSegment(
                        id=segment.id,
                        start=segment.start,
                        end=segment.end,
                        text=segment.text,
                    )
                )
                if on_segment is not None:
                    on_segment()
            return TranscriptionResult(
                language=info.language,
                language_probability=info.language_probability,
                duration_seconds=duration_seconds,
                segments=tuple(validated_segments),
            )
        except WorkerError:
            raise
        except Exception:  # noqa: BLE001 - normalize the untyped native iterator boundary.
            raise WorkerError(TRANSCRIPTION_FAILED) from None

    def _get_model(self) -> WhisperModelPort:
        if self._model is None:
            self._model = self._model_factory(self._model_path)
        return self._model


def _require_requested_language(
    detected_language: str,
    requested_language: RunpodExecutionLanguage | None,
) -> None:
    if requested_language is not None and detected_language != requested_language:
        raise WorkerError(TRANSCRIPTION_FAILED)


__all__ = [
    "MODEL_NAME",
    "FasterWhisperTranscriber",
    "TranscriptionResult",
    "create_faster_whisper_model",
]
