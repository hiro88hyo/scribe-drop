"""Tests for the deterministic, non-human speech quality fixture."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest

if TYPE_CHECKING:
    from collections.abc import Callable

from scribe_drop_worker.bounded_transcription import SAMPLE_RATE
from scribe_drop_worker.speech_quality_fixture import (
    BOUNDARY_SECONDS,
    ESPEAK_PATH,
    FFMPEG_PATH,
    FIXTURE_DURATION_SECONDS,
    MAX_SPEECH_SECONDS,
    MIN_SPEECH_SECONDS,
    PCM_BYTES_PER_SAMPLE,
    WAVE_HEADER_BYTES,
    SpeechQualityFixtureError,
    _fixture_intervals,
    _run_command,
    generate_speech_quality_fixture,
)

EXPECTED_COMMAND_COUNT: Final = 2
EXPECTED_INTERVAL_COUNT: Final = 3
SPEECH_SECONDS: Final = MIN_SPEECH_SECONDS


def _successful_runner(commands: list[tuple[str, ...]]) -> Callable[[tuple[str, ...], float], None]:
    def run(command: tuple[str, ...], _timeout_seconds: float) -> None:
        commands.append(command)
        output = Path(command[-2] if command[0] == ESPEAK_PATH else command[-1])
        if command[0] == ESPEAK_PATH:
            output.write_bytes(b"synthetic-wave")
        else:
            output.write_bytes(bytes(SPEECH_SECONDS * SAMPLE_RATE * PCM_BYTES_PER_SAMPLE))

    return run


def test_generator_uses_fixed_commands_writes_exact_wave_and_removes_intermediates(
    tmp_path: Path,
) -> None:
    """The fixture has fixed provenance, layout, permissions, and no retained source files."""
    commands: list[tuple[str, ...]] = []

    fixture = generate_speech_quality_fixture(
        tmp_path,
        run_command=_successful_runner(commands),
    )

    assert len(commands) == EXPECTED_COMMAND_COUNT
    assert commands[0][0] == ESPEAK_PATH
    assert commands[0][1:3] == ("-v", "ja")
    assert commands[1][0] == FFMPEG_PATH
    assert commands[1][-2:] == ("s16le", str(tmp_path / "synthesized-source.s16le"))
    assert fixture.path == tmp_path / "speech-quality.wav"
    assert fixture.duration_seconds == FIXTURE_DURATION_SECONDS
    assert len(fixture.speech_intervals) == EXPECTED_INTERVAL_COUNT
    assert fixture.boundary_interval.start_seconds < BOUNDARY_SECONDS
    assert fixture.boundary_interval.end_seconds > BOUNDARY_SECONDS
    assert fixture.path.stat().st_size == (
        WAVE_HEADER_BYTES + FIXTURE_DURATION_SECONDS * SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
    )
    with fixture.path.open("rb") as source:
        assert source.read(4) == b"RIFF"
    assert fixture.path.stat().st_mode & 0o077 == 0
    assert not (tmp_path / "synthesized-source.wav").exists()
    assert not (tmp_path / "synthesized-source.s16le").exists()


@pytest.mark.parametrize(
    "pcm_size",
    [
        1,
        (MIN_SPEECH_SECONDS * SAMPLE_RATE - 1) * PCM_BYTES_PER_SAMPLE,
        (MAX_SPEECH_SECONDS * SAMPLE_RATE + 1) * PCM_BYTES_PER_SAMPLE,
    ],
)
def test_interval_planner_rejects_partial_short_and_long_synthesis(pcm_size: int) -> None:
    """Synthesized audio cannot evade alignment or fixed duration bounds."""
    with pytest.raises(SpeechQualityFixtureError) as failure:
        _fixture_intervals(pcm_size)
    assert failure.value.code == "FIXTURE_INVALID"


def test_generator_rejects_foreign_task_directory_and_cleans_partial_output(
    tmp_path: Path,
) -> None:
    """Only a real /tmp directory is accepted and failures remove all partial files."""
    with pytest.raises(SpeechQualityFixtureError) as foreign:
        generate_speech_quality_fixture(Path("relative"))
    assert foreign.value.code == "FIXTURE_INVALID"

    calls = 0

    def fail_second(command: tuple[str, ...], _timeout_seconds: float) -> None:
        nonlocal calls
        calls += 1
        if command[0] == ESPEAK_PATH:
            Path(command[-2]).write_bytes(b"synthetic-wave")
            return
        Path(command[-1]).write_bytes(b"partial")
        msg = "native detail that must not escape"
        raise RuntimeError(msg)

    with pytest.raises(SpeechQualityFixtureError) as generation:
        generate_speech_quality_fixture(tmp_path, run_command=fail_second)
    assert generation.value.code == "FIXTURE_GENERATION_FAILED"
    assert "native" not in str(generation.value)
    assert calls == EXPECTED_COMMAND_COUNT
    assert tuple(tmp_path.iterdir()) == ()


@pytest.mark.parametrize(
    ("completed", "raises"),
    [
        (subprocess.CompletedProcess(("fixed",), 1), None),
        (None, OSError("sensitive")),
        (None, subprocess.TimeoutExpired(("fixed",), 1)),
    ],
)
def test_real_command_adapter_normalizes_exit_spawn_and_timeout(
    monkeypatch: pytest.MonkeyPatch,
    completed: subprocess.CompletedProcess[bytes] | None,
    raises: Exception | None,
) -> None:
    """No subprocess error text crosses the fixture boundary."""

    def fake_run(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if raises is not None:
            raise raises
        assert completed is not None
        return completed

    monkeypatch.setattr("scribe_drop_worker.speech_quality_fixture.subprocess.run", fake_run)
    with pytest.raises(SpeechQualityFixtureError) as failure:
        _run_command(("/fixed",), 1)
    assert failure.value.code == "FIXTURE_GENERATION_FAILED"


def test_generator_rejects_symlinked_or_preexisting_destination(tmp_path: Path) -> None:
    """Exclusive create prevents replacing a foreign fixture path."""
    destination = tmp_path / "speech-quality.wav"
    destination.write_bytes(b"foreign")
    destination.chmod(0o600)
    with pytest.raises(SpeechQualityFixtureError) as failure:
        generate_speech_quality_fixture(tmp_path, run_command=_successful_runner([]))
    assert failure.value.code == "FIXTURE_INVALID"
    assert destination.read_bytes() == b"foreign"
