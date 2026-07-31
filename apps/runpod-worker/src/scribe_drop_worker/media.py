"""Bounded ffprobe execution and media validation."""

from __future__ import annotations

import math
import subprocess
from typing import TYPE_CHECKING, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .constants import MAX_STREAMS
from .errors import WorkerError

if TYPE_CHECKING:
    from pathlib import Path

FFPROBE_PATH: Final = "/usr/bin/ffprobe"
FFPROBE_TIMEOUT_SECONDS: Final = 60
MAX_FFPROBE_OUTPUT_BYTES: Final = 1024 * 1024
INVALID_MEDIA: Final = "INVALID_MEDIA"
DURATION_LIMIT_EXCEEDED: Final = "DURATION_LIMIT_EXCEEDED"

ALLOWED_FORMATS: Final = frozenset(
    {
        "flac",
        "matroska",
        "mov",
        "mp3",
        "mp4",
        "ogg",
        "wav",
        "webm",
    }
)
ALLOWED_AUDIO_CODECS: Final = frozenset(
    {
        "aac",
        "flac",
        "mp3",
        "opus",
        "pcm_f32le",
        "pcm_f64le",
        "pcm_s16le",
        "pcm_s24le",
        "pcm_s32le",
        "vorbis",
    }
)


class ProbeStream(BaseModel):
    """Selected ffprobe stream fields."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    index: int = Field(ge=0)
    codec_name: str | None = None
    codec_type: Literal["attachment", "audio", "data", "subtitle", "video"]


class ProbeFormat(BaseModel):
    """Selected ffprobe container fields."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    format_name: str
    duration: str


class ProbeOutput(BaseModel):
    """Bounded ffprobe JSON response."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    programs: tuple[()] = ()
    streams: tuple[ProbeStream, ...]
    format: ProbeFormat


class MediaInfo(BaseModel):
    """Validated media facts safe for logs and inference."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    duration_seconds: float = Field(gt=0)
    stream_count: int = Field(gt=0, le=MAX_STREAMS)
    format_name: str
    audio_codec: str


class FfprobeMediaProbe:
    """Run the fixed ffprobe binary with an argument array."""

    def __init__(self, *, executable: str = FFPROBE_PATH) -> None:
        """Pin the executable path at construction."""
        self._executable = executable

    def probe(self, source: Path, *, max_duration_seconds: float) -> MediaInfo:
        """Probe and validate one regular file below ``/tmp``."""
        if (
            not source.is_absolute()
            or not source.is_relative_to("/tmp")  # noqa: S108 - required ephemeral task root.
            or source.is_symlink()
            or not source.is_file()
        ):
            raise WorkerError(INVALID_MEDIA)
        command = (
            self._executable,
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration:stream=index,codec_type,codec_name",
            "-of",
            "json",
            str(source),
        )
        try:
            completed = subprocess.run(  # noqa: S603 - fixed executable and argument array.
                command,
                check=False,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=FFPROBE_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise WorkerError(INVALID_MEDIA) from None
        if (
            completed.returncode != 0
            or len(completed.stdout) > MAX_FFPROBE_OUTPUT_BYTES
            or len(completed.stderr) > MAX_FFPROBE_OUTPUT_BYTES
        ):
            raise WorkerError(INVALID_MEDIA)
        try:
            output = ProbeOutput.model_validate_json(completed.stdout)
        except ValidationError:
            raise WorkerError(INVALID_MEDIA) from None
        return _validate_probe_output(output, max_duration_seconds=max_duration_seconds)


def _validate_probe_output(output: ProbeOutput, *, max_duration_seconds: float) -> MediaInfo:
    if not output.streams or len(output.streams) > MAX_STREAMS:
        raise WorkerError(INVALID_MEDIA)
    formats = frozenset(output.format.format_name.split(","))
    accepted_formats = formats.intersection(ALLOWED_FORMATS)
    if not accepted_formats:
        raise WorkerError(INVALID_MEDIA)
    audio_codecs = tuple(
        stream.codec_name
        for stream in output.streams
        if stream.codec_type == "audio"
        and stream.codec_name is not None
        and stream.codec_name in ALLOWED_AUDIO_CODECS
    )
    if not audio_codecs:
        raise WorkerError(INVALID_MEDIA)
    try:
        duration = float(output.format.duration)
    except ValueError:
        raise WorkerError(INVALID_MEDIA) from None
    if not math.isfinite(duration) or duration <= 0:
        raise WorkerError(INVALID_MEDIA)
    if duration > max_duration_seconds:
        raise WorkerError(DURATION_LIMIT_EXCEEDED)
    return MediaInfo(
        duration_seconds=duration,
        stream_count=len(output.streams),
        format_name=sorted(accepted_formats)[0],
        audio_codec=audio_codecs[0],
    )
