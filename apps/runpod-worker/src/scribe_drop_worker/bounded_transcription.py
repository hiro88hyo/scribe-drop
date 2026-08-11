"""Bounded window planning, segment ownership, prompt tail, and local spool."""

from __future__ import annotations

import json
import math
import os
import stat
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from pydantic import Field, ValidationInfo, field_validator

from .constants import MAX_DURATION_SECONDS
from .contracts import StrictModel, TranscriptSegment
from .errors import WorkerError

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator
    from pathlib import Path
    from types import TracebackType
    from typing import BinaryIO, Self

SAMPLE_RATE: Final = 16_000
PCM_BYTES_PER_SAMPLE: Final = 4
CORE_SECONDS: Final = 15 * 60
CONTEXT_SECONDS: Final = 30
CORE_SAMPLES: Final = CORE_SECONDS * SAMPLE_RATE
CONTEXT_SAMPLES: Final = CONTEXT_SECONDS * SAMPLE_RATE
MAX_DURATION_SAMPLES: Final = MAX_DURATION_SECONDS * SAMPLE_RATE
MAX_WINDOW_SAMPLES: Final = (CORE_SECONDS + 2 * CONTEXT_SECONDS) * SAMPLE_RATE
MAX_WINDOW_BYTES: Final = MAX_WINDOW_SAMPLES * PCM_BYTES_PER_SAMPLE

MAX_SEGMENTS: Final = 100_000
MAX_RAW_SEGMENTS_PER_WINDOW: Final = 10_000
MAX_SEGMENT_TEXT_BYTES: Final = 16 * 1024
MAX_TOTAL_TEXT_BYTES: Final = 64 * 1024 * 1024
MAX_SPOOL_BYTES: Final = 128 * 1024 * 1024
MAX_SPOOL_ROW_BYTES: Final = 40 * 1024
MAX_PROMPT_BYTES: Final = 8 * 1024
UTF8_CONTINUATION_MASK: Final = 0xC0
UTF8_CONTINUATION_PREFIX: Final = 0x80

TRANSCRIPTION_FAILED: Final = "TRANSCRIPTION_FAILED"
INTERNAL_ERROR: Final = "INTERNAL_ERROR"


@dataclass(frozen=True, slots=True)
class WindowSpec:
    """One deterministic core interval and its available acoustic context."""

    index: int
    core_start_sample: int
    core_end_sample: int
    window_start_sample: int
    window_end_sample: int
    is_last: bool

    @property
    def core_start_seconds(self) -> float:
        """Return the exact core start in seconds."""
        return self.core_start_sample / SAMPLE_RATE

    @property
    def core_end_seconds(self) -> float:
        """Return the exact core end in seconds."""
        return self.core_end_sample / SAMPLE_RATE

    @property
    def window_start_seconds(self) -> float:
        """Return the exact inference window start in seconds."""
        return self.window_start_sample / SAMPLE_RATE

    @property
    def window_duration_seconds(self) -> float:
        """Return the selected PCM window duration in seconds."""
        return (self.window_end_sample - self.window_start_sample) / SAMPLE_RATE


def plan_windows(total_samples: int) -> tuple[WindowSpec, ...]:
    """Plan all half-open cores from the decoder's actual sample count."""
    if isinstance(total_samples, bool) or not 0 < total_samples <= MAX_DURATION_SAMPLES:
        raise WorkerError(TRANSCRIPTION_FAILED)
    windows: list[WindowSpec] = []
    for index, core_start in enumerate(range(0, total_samples, CORE_SAMPLES)):
        core_end = min(core_start + CORE_SAMPLES, total_samples)
        windows.append(
            WindowSpec(
                index=index,
                core_start_sample=core_start,
                core_end_sample=core_end,
                window_start_sample=max(0, core_start - CONTEXT_SAMPLES),
                window_end_sample=min(total_samples, core_end + CONTEXT_SAMPLES),
                is_last=core_end == total_samples,
            )
        )
    return tuple(windows)


class RawWindowSegment(StrictModel):
    """Exact faster-whisper fields accepted by the bounded merge boundary."""

    id: int = Field(ge=0)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str

    @field_validator("start", "end")
    @classmethod
    def timestamp_is_finite(cls, value: float) -> float:
        """Reject NaN and infinity before timestamp ownership decisions."""
        if not math.isfinite(value):
            msg = "segment timestamp must be finite"
            raise ValueError(msg)
        return value

    @field_validator("end")
    @classmethod
    def end_does_not_precede_start(cls, value: float, info: ValidationInfo) -> float:
        """Reject malformed native segment ordering."""
        start = info.data.get("start")
        if isinstance(start, int | float) and value < start:
            msg = "segment end must not precede start"
            raise ValueError(msg)
        return value

    @field_validator("text")
    @classmethod
    def text_is_bounded_utf8(cls, value: str) -> str:
        """Bound text by encoded bytes rather than Unicode code points."""
        if len(value.encode("utf-8")) > MAX_SEGMENT_TEXT_BYTES:
            msg = "segment text exceeded the UTF-8 limit"
            raise ValueError(msg)
        return value


@dataclass(frozen=True, slots=True)
class SpoolLimits:
    """Hard limits used by both production code and focused overflow tests."""

    max_segments: int = MAX_SEGMENTS
    max_text_bytes: int = MAX_TOTAL_TEXT_BYTES
    max_spool_bytes: int = MAX_SPOOL_BYTES


DEFAULT_SPOOL_LIMITS: Final = SpoolLimits()


class PromptTail:
    """Retain only a normalized UTF-8 suffix for the next inference window."""

    def __init__(self, *, max_bytes: int = MAX_PROMPT_BYTES) -> None:
        """Create an empty bounded prompt."""
        if max_bytes <= 0:
            msg = "max_bytes must be positive"
            raise ValueError(msg)
        self._max_bytes = max_bytes
        self._value = ""

    @property
    def value(self) -> str:
        """Return the safe prompt for the next model call."""
        return self._value

    def append(self, text: str) -> None:
        """Normalize whitespace and retain a code-point-safe suffix."""
        normalized = " ".join(text.split())
        if not normalized:
            return
        combined = f"{self._value} {normalized}" if self._value else normalized
        encoded = combined.encode("utf-8")
        if len(encoded) <= self._max_bytes:
            self._value = combined
            return
        suffix = encoded[-self._max_bytes :]
        while suffix and suffix[0] & UTF8_CONTINUATION_MASK == UTF8_CONTINUATION_PREFIX:
            suffix = suffix[1:]
        self._value = suffix.decode("utf-8")


class SegmentSpool:
    """Exclusive, bounded JSON Lines spool for accepted transcript segments."""

    def __init__(
        self,
        task_directory: Path,
        *,
        limits: SpoolLimits = DEFAULT_SPOOL_LIMITS,
    ) -> None:
        """Create one mode-0600 file below an existing task directory."""
        if (
            not task_directory.is_absolute()
            or not task_directory.is_relative_to("/tmp")  # noqa: S108 - fixed task root.
            or task_directory.is_symlink()
            or not task_directory.is_dir()
        ):
            raise WorkerError(INTERNAL_ERROR)
        self._path = task_directory / "segments.jsonl"
        self._limits = limits
        self._segment_count = 0
        self._text_bytes = 0
        self._spool_bytes = 0
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        try:
            descriptor = os.open(self._path, flags, 0o600)
        except OSError:
            raise WorkerError(INTERNAL_ERROR) from None
        try:
            file_info = os.fstat(descriptor)
        except OSError:
            os.close(descriptor)
            raise WorkerError(INTERNAL_ERROR) from None
        if not stat.S_ISREG(file_info.st_mode):
            os.close(descriptor)
            raise WorkerError(INTERNAL_ERROR)
        try:
            self._file: BinaryIO = os.fdopen(descriptor, "w+b", buffering=0)
        except OSError:
            os.close(descriptor)
            raise WorkerError(INTERNAL_ERROR) from None

    @property
    def segment_count(self) -> int:
        """Return the number of accepted, persisted segments."""
        return self._segment_count

    @property
    def size_bytes(self) -> int:
        """Return the exact JSON Lines byte count."""
        return self._spool_bytes

    @property
    def path(self) -> Path:
        """Expose the safe task-local path for test and cleanup evidence."""
        return self._path

    def append(self, *, start: float, end: float, text: str) -> TranscriptSegment:
        """Append one validated segment without retaining transcript history in memory."""
        text_bytes = len(text.encode("utf-8"))
        if text_bytes > MAX_SEGMENT_TEXT_BYTES:
            raise WorkerError(TRANSCRIPTION_FAILED)
        try:
            segment = TranscriptSegment(
                id=self._segment_count,
                start=start,
                end=end,
                text=text,
            )
            row = (
                json.dumps(
                    segment.model_dump(mode="json"),
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                    allow_nan=False,
                ).encode("utf-8")
                + b"\n"
            )
        except WorkerError:
            raise
        except (UnicodeError, ValueError):
            raise WorkerError(TRANSCRIPTION_FAILED) from None
        if (
            self._segment_count + 1 > self._limits.max_segments
            or self._text_bytes + text_bytes > self._limits.max_text_bytes
            or self._spool_bytes + len(row) > self._limits.max_spool_bytes
            or len(row) > MAX_SPOOL_ROW_BYTES
        ):
            raise WorkerError(TRANSCRIPTION_FAILED)
        try:
            self._file.seek(0, os.SEEK_END)
            written = self._file.write(row)
        except OSError:
            raise WorkerError(INTERNAL_ERROR) from None
        if written != len(row):
            raise WorkerError(INTERNAL_ERROR)
        self._segment_count += 1
        self._text_bytes += text_bytes
        self._spool_bytes += len(row)
        return segment

    def iter_segments(self) -> Iterator[TranscriptSegment]:
        """Validate and stream every persisted row with a bounded read."""
        try:
            self._file.flush()
            self._file.seek(0)
        except OSError:
            raise WorkerError(INTERNAL_ERROR) from None
        observed = 0
        while True:
            try:
                row = self._file.readline(MAX_SPOOL_ROW_BYTES + 1)
            except OSError:
                raise WorkerError(INTERNAL_ERROR) from None
            if not row:
                break
            if len(row) > MAX_SPOOL_ROW_BYTES or not row.endswith(b"\n"):
                raise WorkerError(INTERNAL_ERROR)
            try:
                yield TranscriptSegment.model_validate_json(row)
            except ValueError:
                raise WorkerError(INTERNAL_ERROR) from None
            observed += 1
        if observed != self._segment_count:
            raise WorkerError(INTERNAL_ERROR)

    def close(self) -> None:
        """Close and remove the sensitive task-local spool idempotently."""
        try:
            self._file.close()
        finally:
            try:
                self._path.unlink(missing_ok=True)
            except OSError:
                raise WorkerError(INTERNAL_ERROR) from None

    def __enter__(self) -> Self:
        """Return the active spool."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Remove the sensitive spool on every exit path."""
        del exc_type, exc_value, traceback
        self.close()


@dataclass(frozen=True, slots=True)
class WindowMergeSummary:
    """Safe counters returned after one window merge."""

    raw_segment_count: int
    accepted_segment_count: int


class WindowSegmentMerger:
    """Assign overlapping raw segments to exactly one ordered core."""

    def __init__(self, spool: SegmentSpool, prompt: PromptTail) -> None:
        """Bind one spool and prompt to a sequential attempt."""
        self._spool = spool
        self._prompt = prompt
        self._next_window_index = 0

    def merge(
        self,
        window: WindowSpec,
        segments: Iterable[RawWindowSegment],
        *,
        on_segment: Callable[[], None] | None = None,
    ) -> WindowMergeSummary:
        """Validate order, translate timestamps, and persist owned segments."""
        if window.index != self._next_window_index:
            raise WorkerError(TRANSCRIPTION_FAILED)
        raw_count = 0
        accepted_count = 0
        previous_order: tuple[float, float, float, int] | None = None
        for segment in segments:
            raw_count += 1
            if raw_count > MAX_RAW_SEGMENTS_PER_WINDOW:
                raise WorkerError(TRANSCRIPTION_FAILED)
            if segment.end > window.window_duration_seconds:
                raise WorkerError(TRANSCRIPTION_FAILED)
            local_midpoint = (segment.start + segment.end) / 2
            order = (local_midpoint, segment.start, segment.end, segment.id)
            if previous_order is not None and order < previous_order:
                raise WorkerError(TRANSCRIPTION_FAILED)
            previous_order = order
            global_start = window.window_start_seconds + segment.start
            global_end = window.window_start_seconds + segment.end
            global_midpoint = window.window_start_seconds + local_midpoint
            owned = window.core_start_seconds <= global_midpoint < window.core_end_seconds
            if window.is_last and global_midpoint == window.core_end_seconds:
                owned = True
            if owned:
                self._spool.append(start=global_start, end=global_end, text=segment.text)
                self._prompt.append(segment.text)
                accepted_count += 1
            if on_segment is not None:
                on_segment()
        self._next_window_index += 1
        return WindowMergeSummary(
            raw_segment_count=raw_count,
            accepted_segment_count=accepted_count,
        )


__all__ = [
    "CONTEXT_SAMPLES",
    "CONTEXT_SECONDS",
    "CORE_SAMPLES",
    "CORE_SECONDS",
    "MAX_DURATION_SAMPLES",
    "MAX_PROMPT_BYTES",
    "MAX_SEGMENTS",
    "MAX_SEGMENT_TEXT_BYTES",
    "MAX_SPOOL_BYTES",
    "MAX_TOTAL_TEXT_BYTES",
    "MAX_WINDOW_BYTES",
    "MAX_WINDOW_SAMPLES",
    "PCM_BYTES_PER_SAMPLE",
    "SAMPLE_RATE",
    "PromptTail",
    "RawWindowSegment",
    "SegmentSpool",
    "SpoolLimits",
    "WindowMergeSummary",
    "WindowSegmentMerger",
    "WindowSpec",
    "plan_windows",
]
