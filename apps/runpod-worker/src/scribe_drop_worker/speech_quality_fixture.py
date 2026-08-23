"""Generate a deterministic, non-human Japanese speech-like quality fixture."""

from __future__ import annotations

import os
import struct
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from pathlib import Path

from .bounded_transcription import CORE_SECONDS, SAMPLE_RATE

ESPEAK_PATH: Final = "/usr/bin/espeak-ng"
FFMPEG_PATH: Final = "/usr/bin/ffmpeg"
SYNTHESIS_TIMEOUT_SECONDS: Final = 60.0
RESAMPLE_TIMEOUT_SECONDS: Final = 60.0
FIXTURE_DURATION_SECONDS: Final = 16 * 60
BOUNDARY_SECONDS: Final = CORE_SECONDS
PCM_BYTES_PER_SAMPLE: Final = 2
WAVE_HEADER_BYTES: Final = 44
MIN_SPEECH_SECONDS: Final = 12
MAX_SPEECH_SECONDS: Final = 30
MAX_SYNTHESIZED_PCM_BYTES: Final = MAX_SPEECH_SECONDS * SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
ZERO_WRITE_CHUNK_BYTES: Final = 1024 * 1024
EXPECTED_SPEECH_INTERVALS: Final = 3
ESPEAK_VOICE: Final = "ja"
ENGLISH_ESPEAK_VOICE: Final = "en-us"
ESPEAK_RATE: Final = "140"
ESPEAK_PITCH: Final = "50"
ESPEAK_AMPLITUDE: Final = "100"

# These distinct texts are synthetic test material, not user content. They are never emitted to
# logs or artifacts. Distinct utterances prevent repeated-speech hallucination from masking the
# window-boundary behavior under test.
SYNTHETIC_JAPANESE_TEXTS: Final = (
    (
        "これは もじおこしの かいしぶぶんを かくにんする ための ごうせいおんせいです。"
        "あさの ひかりと しずかな へやを そうぞうしながら、"
        "はじめの ことばを じゅんばんに よみます。"
        "おんせいの いちと ながさが きめられた はんいに おさまることを たしかめます。"
    ),
    (
        "じゅうごふんの きょうかいを またいで、"
        "ながい ぶんしょうを とちゅうで きらずに よみあげます。"
        "まえの まどと あとの まどで、"
        "ことばが ぬけたり くりかえされたり しないことを たしかめます。"
        "ぶんみゃくと じゅんじょを たもち、きょうかいの りょうがわを せいかくに つなぎます。"
    ),
    (
        "これは ろくおんの しゅうりょうちかくを かくにんする ための べつの ごうせいおんせいです。"
        "やまの みどりと かわの ながれを おもいうかべながら、さいごの ことばを ゆっくり よみます。"
        "しゅうたんまで けっかを うしなわず、きめられた じゅんじょで かんりょうします。"
    ),
)

SYNTHETIC_ENGLISH_TEXTS: Final = (
    (
        "This synthetic recording checks the beginning of an English transcription. "
        "Morning light reaches a quiet room while each word is spoken in a fixed order. "
        "The position and duration of the audio remain inside the reviewed interval."
    ),
    (
        "This longer sentence crosses the fifteen minute boundary without changing language. "
        "The window before the boundary and the window after it must preserve every phrase, "
        "avoid repetitions, and join the ordered context into one stable English transcript."
    ),
    (
        "This separate synthetic recording checks the end of the file. "
        "Green hills and a flowing river provide harmless fixed words for the final interval. "
        "The result keeps its order and completes without losing the last sentence."
    ),
)

FixtureErrorCode = Literal["FIXTURE_GENERATION_FAILED", "FIXTURE_INVALID"]
FIXTURE_GENERATION_FAILED: Final[FixtureErrorCode] = "FIXTURE_GENERATION_FAILED"
FIXTURE_INVALID: Final[FixtureErrorCode] = "FIXTURE_INVALID"


class SpeechQualityFixtureError(Exception):
    """Allowlisted fixture failure that never retains subprocess details."""

    def __init__(self, code: FixtureErrorCode) -> None:
        """Retain only a stable code."""
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class SpeechInterval:
    """One known synthesized-speech interval in global sample coordinates."""

    start_sample: int
    end_sample: int

    @property
    def start_seconds(self) -> float:
        """Return the exact interval start in seconds."""
        return self.start_sample / SAMPLE_RATE

    @property
    def end_seconds(self) -> float:
        """Return the exact interval end in seconds."""
        return self.end_sample / SAMPLE_RATE


@dataclass(frozen=True, slots=True)
class SpeechQualityFixture:
    """Safe fixture metadata; the audio and dummy text are deliberately excluded."""

    path: Path
    duration_seconds: int
    speech_intervals: tuple[SpeechInterval, ...]

    @property
    def boundary_interval(self) -> SpeechInterval:
        """Return the single interval that crosses the production core boundary."""
        matches = tuple(
            interval
            for interval in self.speech_intervals
            if interval.start_seconds < BOUNDARY_SECONDS < interval.end_seconds
        )
        if len(matches) != 1:
            raise SpeechQualityFixtureError(FIXTURE_INVALID)
        return matches[0]


@dataclass(frozen=True, slots=True)
class _SpeechFixtureDefinition:
    destination_name: str
    source_prefix: str
    texts: tuple[str, ...]
    voice: str


JAPANESE_FIXTURE: Final = _SpeechFixtureDefinition(
    destination_name="speech-quality.wav",
    source_prefix="synthesized-source",
    texts=SYNTHETIC_JAPANESE_TEXTS,
    voice=ESPEAK_VOICE,
)
ENGLISH_FIXTURE: Final = _SpeechFixtureDefinition(
    destination_name="english-speech-quality.wav",
    source_prefix="english-synthesized-source",
    texts=SYNTHETIC_ENGLISH_TEXTS,
    voice=ENGLISH_ESPEAK_VOICE,
)


CommandRunner = Callable[[tuple[str, ...], float], None]


def _run_command(command: tuple[str, ...], timeout_seconds: float) -> None:
    try:
        completed = subprocess.run(  # noqa: S603 - fixed executable and argument array.
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED) from None
    if completed.returncode != 0:
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED)


def generate_speech_quality_fixture(
    task_directory: Path,
    *,
    run_command: CommandRunner = _run_command,
) -> SpeechQualityFixture:
    """Generate one fixed 16-minute WAV with three distinct synthesized speech islands."""
    return _generate_speech_quality_fixture(
        task_directory,
        definition=JAPANESE_FIXTURE,
        run_command=run_command,
    )


def generate_english_speech_quality_fixture(
    task_directory: Path,
    *,
    run_command: CommandRunner = _run_command,
) -> SpeechQualityFixture:
    """Generate the fixed non-human English fixture used by the native language gate."""
    return _generate_speech_quality_fixture(
        task_directory,
        definition=ENGLISH_FIXTURE,
        run_command=run_command,
    )


def _generate_speech_quality_fixture(
    task_directory: Path,
    *,
    definition: _SpeechFixtureDefinition,
    run_command: CommandRunner,
) -> SpeechQualityFixture:
    _validate_task_directory(task_directory)
    source_waves = tuple(
        task_directory / f"{definition.source_prefix}-{index}.wav"
        for index in range(len(definition.texts))
    )
    source_pcms = tuple(
        task_directory / f"{definition.source_prefix}-{index}.s16le"
        for index in range(len(definition.texts))
    )
    destination = task_directory / definition.destination_name
    if any(
        path.exists() or path.is_symlink() for path in (*source_waves, *source_pcms, destination)
    ):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    destination_created = False
    fixture: SpeechQualityFixture | None = None
    try:
        speech_pcm_values: list[bytes] = []
        for text, source_wave, source_pcm in zip(
            definition.texts,
            source_waves,
            source_pcms,
            strict=True,
        ):
            run_command(
                (
                    ESPEAK_PATH,
                    "-v",
                    definition.voice,
                    "-s",
                    ESPEAK_RATE,
                    "-p",
                    ESPEAK_PITCH,
                    "-a",
                    ESPEAK_AMPLITUDE,
                    "-w",
                    str(source_wave),
                    text,
                ),
                SYNTHESIS_TIMEOUT_SECONDS,
            )
            _validate_generated_file(source_wave, max_bytes=MAX_SYNTHESIZED_PCM_BYTES * 2)
            run_command(
                (
                    FFMPEG_PATH,
                    "-nostdin",
                    "-v",
                    "error",
                    "-xerror",
                    "-i",
                    str(source_wave),
                    "-map",
                    "0:0",
                    "-vn",
                    "-sn",
                    "-dn",
                    "-ac",
                    "1",
                    "-ar",
                    str(SAMPLE_RATE),
                    "-f",
                    "s16le",
                    str(source_pcm),
                ),
                RESAMPLE_TIMEOUT_SECONDS,
            )
            _validate_generated_file(source_pcm, max_bytes=MAX_SYNTHESIZED_PCM_BYTES)
            speech_pcm_values.append(source_pcm.read_bytes())
        speech_pcms = tuple(speech_pcm_values)
        intervals = _fixture_intervals(tuple(len(value) for value in speech_pcms))
        _write_pcm_wave(destination, speech_pcms=speech_pcms, intervals=intervals)
        destination_created = True
        _validate_fixture_file(destination)
        fixture = SpeechQualityFixture(
            path=destination,
            duration_seconds=FIXTURE_DURATION_SECONDS,
            speech_intervals=intervals,
        )
        _ = fixture.boundary_interval
    except SpeechQualityFixtureError:
        if destination_created:
            destination.unlink(missing_ok=True)
        raise
    except Exception:  # noqa: BLE001 - normalize replaceable subprocess and filesystem ports.
        if destination_created:
            destination.unlink(missing_ok=True)
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED) from None
    finally:
        for path in (*source_waves, *source_pcms):
            path.unlink(missing_ok=True)
    if fixture is None:  # pragma: no cover - defensive invariant after successful generation.
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED)
    return fixture


def _validate_task_directory(task_directory: Path) -> None:
    if (
        not task_directory.is_absolute()
        or not task_directory.is_relative_to("/tmp")  # noqa: S108 - fixed ephemeral root.
        or task_directory.is_symlink()
        or not task_directory.is_dir()
    ):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)


def _validate_generated_file(path: Path, *, max_bytes: int) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED) from None
    if path.is_symlink() or not path.is_file() or size <= 0 or size > max_bytes:
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED)


def _fixture_intervals(pcm_size_bytes: tuple[int, ...]) -> tuple[SpeechInterval, ...]:
    if len(pcm_size_bytes) != EXPECTED_SPEECH_INTERVALS:
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    if any(size % PCM_BYTES_PER_SAMPLE != 0 for size in pcm_size_bytes):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    speech_samples = tuple(size // PCM_BYTES_PER_SAMPLE for size in pcm_size_bytes)
    if any(
        not MIN_SPEECH_SECONDS * SAMPLE_RATE <= samples <= MAX_SPEECH_SECONDS * SAMPLE_RATE
        for samples in speech_samples
    ):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    total_samples = FIXTURE_DURATION_SECONDS * SAMPLE_RATE
    boundary_sample = BOUNDARY_SECONDS * SAMPLE_RATE
    starts = (
        10 * SAMPLE_RATE,
        boundary_sample - speech_samples[1] // 2,
        total_samples - speech_samples[2] - 10 * SAMPLE_RATE,
    )
    intervals = tuple(
        SpeechInterval(start_sample=start, end_sample=start + samples)
        for start, samples in zip(starts, speech_samples, strict=True)
    )
    if any(
        interval.start_sample < 0 or interval.end_sample > total_samples for interval in intervals
    ):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    if any(
        current.end_sample >= following.start_sample for current, following in pairwise(intervals)
    ):
        raise SpeechQualityFixtureError(FIXTURE_INVALID)
    return intervals


def _write_pcm_wave(
    destination: Path,
    *,
    speech_pcms: tuple[bytes, ...],
    intervals: tuple[SpeechInterval, ...],
) -> None:
    data_size = FIXTURE_DURATION_SECONDS * SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        SAMPLE_RATE,
        SAMPLE_RATE * PCM_BYTES_PER_SAMPLE,
        PCM_BYTES_PER_SAMPLE,
        PCM_BYTES_PER_SAMPLE * 8,
        b"data",
        data_size,
    )
    descriptor = -1
    created = False
    try:
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        created = True
        with os.fdopen(descriptor, "w+b", buffering=0) as output:
            descriptor = -1
            output.write(header)
            remaining = data_size
            zero_chunk = bytes(min(ZERO_WRITE_CHUNK_BYTES, data_size))
            while remaining > 0:
                current = zero_chunk[: min(len(zero_chunk), remaining)]
                _require_full_write(output.write(current), expected_bytes=len(current))
                remaining -= len(current)
            for speech_pcm, interval in zip(speech_pcms, intervals, strict=True):
                output.seek(WAVE_HEADER_BYTES + interval.start_sample * PCM_BYTES_PER_SAMPLE)
                _require_full_write(output.write(speech_pcm), expected_bytes=len(speech_pcm))
    except OSError:
        if descriptor >= 0:
            os.close(descriptor)
        if created:
            destination.unlink(missing_ok=True)
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED) from None


def _require_full_write(written_bytes: int, *, expected_bytes: int) -> None:
    if written_bytes != expected_bytes:
        raise OSError


def _validate_fixture_file(path: Path) -> None:
    expected_size = (
        WAVE_HEADER_BYTES + FIXTURE_DURATION_SECONDS * SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
    )
    try:
        mode = path.stat().st_mode
        size = path.stat().st_size
    except OSError:
        raise SpeechQualityFixtureError(FIXTURE_GENERATION_FAILED) from None
    if path.is_symlink() or not path.is_file() or size != expected_size or mode & 0o077:
        raise SpeechQualityFixtureError(FIXTURE_INVALID)


__all__ = [
    "BOUNDARY_SECONDS",
    "ENGLISH_ESPEAK_VOICE",
    "ESPEAK_PATH",
    "FFMPEG_PATH",
    "FIXTURE_DURATION_SECONDS",
    "SYNTHETIC_ENGLISH_TEXTS",
    "SYNTHETIC_JAPANESE_TEXTS",
    "SpeechInterval",
    "SpeechQualityFixture",
    "SpeechQualityFixtureError",
    "generate_english_speech_quality_fixture",
    "generate_speech_quality_fixture",
]
