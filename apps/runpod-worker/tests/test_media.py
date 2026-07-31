"""Tests for bounded ffprobe execution and validation."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from scribe_drop_worker.errors import WorkerError
from scribe_drop_worker.media import FfprobeMediaProbe

EXPECTED_DURATION = 60.5
EXPECTED_PIXEL_STREAM_COUNT = 4


def probe_output(
    *,
    duration: str = "60.5",
    format_name: str = "mp3",
    codec_name: str = "mp3",
    stream_count: int = 1,
) -> bytes:
    """Return selected ffprobe fields only."""
    return json.dumps(
        {
            "programs": [],
            "streams": [
                {"index": index, "codec_name": codec_name, "codec_type": "audio"}
                for index in range(stream_count)
            ],
            "format": {"format_name": format_name, "duration": duration},
        }
    ).encode()


def test_ffprobe_uses_fixed_argument_array_and_validates_media(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A supported regular file produces safe media facts."""
    source = tmp_path / "source.bin"
    source.write_bytes(b"media")
    observed: tuple[str, ...] | None = None

    def fake_run(command: tuple[str, ...], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        nonlocal observed
        observed = command
        return subprocess.CompletedProcess(command, 0, stdout=probe_output(), stderr=b"")

    monkeypatch.setattr("scribe_drop_worker.media.subprocess.run", fake_run)
    result = FfprobeMediaProbe().probe(source, max_duration_seconds=120)

    assert result.duration_seconds == EXPECTED_DURATION
    assert result.audio_codec == "mp3"
    assert observed is not None
    assert observed[0] == "/usr/bin/ffprobe"
    assert observed[-1] == str(source)


def test_ffprobe_accepts_auxiliary_data_streams_without_codec_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pixel M4A metadata streams do not invalidate the supported AAC audio stream."""
    source = tmp_path / "source.m4a"
    source.write_bytes(b"synthetic-media")
    stdout = json.dumps(
        {
            "programs": [],
            "streams": [
                {"index": 0, "codec_name": "aac", "codec_type": "audio"},
                {"index": 1, "codec_type": "data"},
                {"index": 2, "codec_type": "data"},
                {"index": 3, "codec_type": "data"},
            ],
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "18.100000",
            },
        }
    ).encode()
    monkeypatch.setattr(
        "scribe_drop_worker.media.subprocess.run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command,
            0,
            stdout=stdout,
            stderr=b"",
        ),
    )

    result = FfprobeMediaProbe().probe(source, max_duration_seconds=120)

    assert result.audio_codec == "aac"
    assert result.duration_seconds == pytest.approx(18.1)
    assert result.format_name == "mov"
    assert result.stream_count == EXPECTED_PIXEL_STREAM_COUNT


@pytest.mark.parametrize(
    ("stdout", "return_code", "code"),
    [
        (b"not-json", 0, "INVALID_MEDIA"),
        (probe_output(duration="unknown"), 0, "INVALID_MEDIA"),
        (probe_output(duration="121"), 0, "DURATION_LIMIT_EXCEEDED"),
        (probe_output(format_name="unknown"), 0, "INVALID_MEDIA"),
        (probe_output(codec_name="unknown"), 0, "INVALID_MEDIA"),
        (probe_output(stream_count=33), 0, "INVALID_MEDIA"),
        (
            json.dumps(
                {
                    "programs": [],
                    "streams": [{"index": 0, "codec_type": "audio"}],
                    "format": {"format_name": "mp4", "duration": "60.5"},
                }
            ).encode(),
            0,
            "INVALID_MEDIA",
        ),
        (
            json.dumps(
                {
                    "programs": [{}],
                    "streams": [{"index": 0, "codec_name": "mp3", "codec_type": "audio"}],
                    "format": {"format_name": "mp3", "duration": "60.5"},
                }
            ).encode(),
            0,
            "INVALID_MEDIA",
        ),
        (b"", 1, "INVALID_MEDIA"),
    ],
)
def test_ffprobe_rejects_invalid_and_oversized_media(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stdout: bytes,
    return_code: int,
    code: str,
) -> None:
    """Container, codec, duration, stream, and process failures are normalized."""
    source = tmp_path / "source.bin"
    source.write_bytes(b"media")
    monkeypatch.setattr(
        "scribe_drop_worker.media.subprocess.run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command,
            return_code,
            stdout=stdout,
            stderr=b"",
        ),
    )
    with pytest.raises(WorkerError) as failure:
        FfprobeMediaProbe().probe(source, max_duration_seconds=120)
    assert failure.value.code == code


def test_ffprobe_rejects_paths_outside_task_tmp() -> None:
    """The worker never probes repository or persistent paths."""
    with pytest.raises(WorkerError) as failure:
        FfprobeMediaProbe().probe(Path("/etc/passwd"), max_duration_seconds=120)
    assert failure.value.code == "INVALID_MEDIA"
