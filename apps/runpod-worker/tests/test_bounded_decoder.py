"""Tests for the single-process bounded PCM decoder."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest

from scribe_drop_worker.bounded_decoder import (
    FFMPEG_PATH,
    MAX_DECODE_BYTES,
    READ_CHUNK_BYTES,
    FfmpegFloat32Stream,
    PcmWindow,
    decode_pcm_windows,
)
from scribe_drop_worker.bounded_transcription import (
    CORE_SAMPLES,
    MAX_DURATION_SAMPLES,
    MAX_WINDOW_BYTES,
    PCM_BYTES_PER_SAMPLE,
    SAMPLE_RATE,
)
from scribe_drop_worker.errors import WorkerError

if TYPE_CHECKING:
    from typing import BinaryIO

ONE_SECOND_BYTES: Final = SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
EXPECTED_EIGHT_HOUR_WINDOWS: Final = 32
EXPECTED_BOUNDARY_WINDOWS: Final = 2


class BytesPcmStream:
    """Deterministic stream with lifecycle observations."""

    def __init__(self, payload: bytes, *, chunk_bytes: int = READ_CHUNK_BYTES) -> None:
        """Store bounded synthetic PCM."""
        self._payload = payload
        self._offset = 0
        self._chunk_bytes = chunk_bytes
        self.finished = False
        self.aborted = False

    def read(self, max_bytes: int) -> bytes:
        """Return the next bounded chunk."""
        size = min(max_bytes, self._chunk_bytes)
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def finish(self) -> None:
        """Record successful EOF verification."""
        self.finished = True

    def abort(self) -> None:
        """Record failure cleanup."""
        self.aborted = True


class VirtualZeroPcmStream:
    """Generate eight hours of PCM without retaining it."""

    def __init__(self, total_bytes: int) -> None:
        """Set the virtual byte count."""
        self._remaining = total_bytes
        self.finished = False
        self.aborted = False

    def read(self, max_bytes: int) -> bytes:
        """Generate only one caller-bounded block."""
        size = min(max_bytes, self._remaining)
        self._remaining -= size
        return bytes(size)

    def finish(self) -> None:
        """Record exact EOF."""
        self.finished = True

    def abort(self) -> None:
        """Record bounded failure cleanup."""
        self.aborted = True


@dataclass
class FakeProcess:
    """Minimal process used to inspect fixed FFmpeg arguments."""

    stdout: BinaryIO | None
    return_code: int = 0
    terminated: bool = False
    killed: bool = False

    def poll(self) -> int | None:
        """Return a terminal status after the pipe is prepared."""
        return self.return_code

    def wait(self, timeout: float | None = None) -> int:
        """Return the fixed status."""
        del timeout
        return self.return_code

    def terminate(self) -> None:
        """Record graceful cleanup."""
        self.terminated = True

    def kill(self) -> None:
        """Record forced cleanup."""
        self.killed = True


def test_single_window_uses_actual_sample_count_and_ephemeral_view() -> None:
    """EOF determines duration and the callback sees one exact float32 window."""
    stream = BytesPcmStream(bytes(ONE_SECOND_BYTES), chunk_bytes=997)
    observed: list[tuple[int, int, bool]] = []

    def consume(window: PcmWindow) -> None:
        assert window.pcm.readonly is True
        observed.append((window.spec.index, window.size_bytes, window.spec.is_last))

    summary = decode_pcm_windows(stream, consume, read_chunk_bytes=1024)

    assert stream.finished is True
    assert stream.aborted is False
    assert summary.total_samples == SAMPLE_RATE
    assert summary.duration_seconds == 1.0
    assert observed == [(0, ONE_SECOND_BYTES, True)]


def test_decoder_reports_bounded_read_progress() -> None:
    """Progress advances per bounded chunk without revealing decoded content."""
    progress = 0

    def on_progress() -> None:
        nonlocal progress
        progress += 1

    decode_pcm_windows(
        BytesPcmStream(bytes(ONE_SECOND_BYTES), chunk_bytes=1024),
        lambda _window: None,
        on_progress=on_progress,
        read_chunk_bytes=1024,
    )
    assert progress == (ONE_SECOND_BYTES + 1023) // 1024


def test_boundary_stream_emits_context_windows_in_order() -> None:
    """A partial second core retains only the required sixty-second overlap."""
    total_samples = CORE_SAMPLES + SAMPLE_RATE
    stream = VirtualZeroPcmStream(total_samples * PCM_BYTES_PER_SAMPLE)
    observed: list[tuple[int, int, bool]] = []

    def consume(window: PcmWindow) -> None:
        observed.append((window.spec.core_end_sample, window.size_bytes, window.spec.is_last))

    summary = decode_pcm_windows(stream, consume)

    assert summary.window_count == EXPECTED_BOUNDARY_WINDOWS
    assert observed[0][2] is False
    assert observed[1][2] is True
    assert observed[1][0] == total_samples


def test_eight_hour_virtual_stream_respects_production_buffer_ceiling() -> None:
    """Production constants process all 32 windows without full-file allocation."""
    stream = VirtualZeroPcmStream(MAX_DECODE_BYTES)
    window_count = 0
    largest_window = 0

    def consume(window: PcmWindow) -> None:
        nonlocal largest_window, window_count
        window_count += 1
        largest_window = max(largest_window, window.size_bytes)

    summary = decode_pcm_windows(stream, consume)

    assert stream.finished is True
    assert summary.total_samples == MAX_DURATION_SAMPLES
    assert summary.window_count == EXPECTED_EIGHT_HOUR_WINDOWS
    assert window_count == EXPECTED_EIGHT_HOUR_WINDOWS
    assert largest_window == MAX_WINDOW_BYTES
    assert summary.peak_buffer_bytes <= MAX_WINDOW_BYTES + READ_CHUNK_BYTES


@pytest.mark.parametrize(
    ("total_bytes", "error_code"),
    [
        (0, "INVALID_MEDIA"),
        (3, "INVALID_MEDIA"),
        (MAX_DECODE_BYTES + PCM_BYTES_PER_SAMPLE, "DURATION_LIMIT_EXCEEDED"),
    ],
)
def test_decoder_rejects_zero_partial_frame_and_over_limit(
    total_bytes: int,
    error_code: str,
) -> None:
    """Invalid actual decode lengths fail without producing a completion summary."""
    stream = VirtualZeroPcmStream(total_bytes)
    with pytest.raises(WorkerError) as failure:
        decode_pcm_windows(stream, lambda _window: None)
    assert failure.value.code == error_code


def test_consumer_failure_is_normalized_after_stream_cleanup() -> None:
    """Unexpected model callbacks cannot escape or skip process cleanup."""
    stream = BytesPcmStream(bytes(ONE_SECOND_BYTES))

    def fail(_window: PcmWindow) -> None:
        msg = "sensitive native detail"
        raise RuntimeError(msg)

    with pytest.raises(WorkerError) as failure:
        decode_pcm_windows(stream, fail)
    assert failure.value.code == "TRANSCRIPTION_FAILED"
    assert stream.finished is True


def test_stream_cannot_bypass_the_requested_read_bound() -> None:
    """A malformed adapter cannot make the rolling buffer accept oversized chunks."""

    class OversizedStream(BytesPcmStream):
        def read(self, max_bytes: int) -> bytes:
            return bytes(max_bytes + 1)

    stream = OversizedStream(b"")
    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        decode_pcm_windows(stream, lambda _window: None, read_chunk_bytes=4)
    assert stream.aborted is True


@pytest.mark.parametrize("read_chunk_bytes", [0, READ_CHUNK_BYTES + 1])
def test_decoder_rejects_invalid_read_bound(read_chunk_bytes: int) -> None:
    """Callers cannot disable or enlarge the fixed decoder read ceiling."""
    stream = BytesPcmStream(bytes(ONE_SECOND_BYTES))
    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        decode_pcm_windows(
            stream,
            lambda _window: None,
            read_chunk_bytes=read_chunk_bytes,
        )
    assert stream.finished is False
    assert stream.aborted is False


def test_unexpected_stream_read_failure_is_normalized_and_aborted() -> None:
    """A native read failure cannot escape details or leave its process alive."""

    class FailingStream(BytesPcmStream):
        def read(self, max_bytes: int) -> bytes:
            del max_bytes
            msg = "sensitive decoder detail"
            raise RuntimeError(msg)

    stream = FailingStream(b"")
    with pytest.raises(WorkerError) as failure:
        decode_pcm_windows(stream, lambda _window: None)
    assert failure.value.code == "TRANSCRIPTION_FAILED"
    assert stream.aborted is True


def test_ffmpeg_stream_uses_fixed_argument_array_and_exact_audio_map(tmp_path: Path) -> None:
    """Only the validated local path and stream index enter the fixed command."""
    source = tmp_path / "source.m4a"
    source.write_bytes(b"synthetic")
    read_descriptor, write_descriptor = os.pipe()
    os.write(write_descriptor, b"\x00\x00\x00\x00")
    os.close(write_descriptor)
    stdout = os.fdopen(read_descriptor, "rb", buffering=0)
    process = FakeProcess(stdout=stdout)
    observed: tuple[str, ...] | None = None

    def factory(command: tuple[str, ...]) -> FakeProcess:
        nonlocal observed
        observed = command
        return process

    stream = FfmpegFloat32Stream(source, audio_stream_index=3, process_factory=factory)
    assert stream.read(PCM_BYTES_PER_SAMPLE) == b"\x00\x00\x00\x00"
    assert stream.read(PCM_BYTES_PER_SAMPLE) == b""
    stream.finish()

    assert observed is not None
    assert observed[0] == FFMPEG_PATH
    assert observed[1:6] == ("-nostdin", "-v", "error", "-xerror", "-i")
    assert observed[6] == str(source)
    assert observed[7:9] == ("-map", "0:3")
    assert observed[-2:] == ("f32le", "pipe:1")


def test_ffmpeg_stream_rejects_stall_and_decoder_aborts(tmp_path: Path) -> None:
    """A decoder stall is permanent for the attempt and the process is reaped."""
    source = tmp_path / "source.m4a"
    source.write_bytes(b"synthetic")
    read_descriptor, write_descriptor = os.pipe()
    stdout = os.fdopen(read_descriptor, "rb", buffering=0)

    class RunningProcess(FakeProcess):
        def poll(self) -> int | None:
            return None

    process = RunningProcess(stdout=stdout)
    stream = FfmpegFloat32Stream(
        source,
        audio_stream_index=0,
        process_factory=lambda _command: process,
        wait_readable=lambda _stream, _timeout: False,
    )
    with pytest.raises(WorkerError) as failure:
        decode_pcm_windows(stream, lambda _window: None)
    os.close(write_descriptor)

    assert failure.value.code == "INVALID_MEDIA"
    assert process.terminated is True


def test_ffmpeg_stream_rejects_paths_outside_tmp() -> None:
    """Persistent and repository paths can never reach FFmpeg."""
    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        FfmpegFloat32Stream(Path("/etc/passwd"), audio_stream_index=0)


def test_ffmpeg_stream_rejects_spawn_pipe_and_exit_failures(tmp_path: Path) -> None:
    """Spawn, missing stdout, and nonzero exit details all collapse to invalid media."""
    source = tmp_path / "source.m4a"
    source.write_bytes(b"synthetic")

    def fail_spawn(_command: tuple[str, ...]) -> FakeProcess:
        raise OSError

    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        FfmpegFloat32Stream(source, audio_stream_index=0, process_factory=fail_spawn)

    missing_pipe = FakeProcess(stdout=None)
    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        FfmpegFloat32Stream(
            source,
            audio_stream_index=0,
            process_factory=lambda _command: missing_pipe,
        )

    read_descriptor, write_descriptor = os.pipe()
    os.close(write_descriptor)
    failed_process = FakeProcess(
        stdout=os.fdopen(read_descriptor, "rb", buffering=0),
        return_code=1,
    )
    stream = FfmpegFloat32Stream(
        source,
        audio_stream_index=0,
        process_factory=lambda _command: failed_process,
    )
    assert stream.read(PCM_BYTES_PER_SAMPLE) == b""
    with pytest.raises(WorkerError, match="INVALID_MEDIA"):
        stream.finish()
