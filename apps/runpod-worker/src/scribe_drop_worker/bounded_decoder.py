"""Single-process FFmpeg float32 decoding with a bounded rolling window."""

from __future__ import annotations

import os
import select
import subprocess
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, BinaryIO, Final, Protocol, cast

from .bounded_transcription import (
    CONTEXT_SAMPLES,
    CORE_SAMPLES,
    MAX_DURATION_SAMPLES,
    PCM_BYTES_PER_SAMPLE,
    SAMPLE_RATE,
    WindowSpec,
)
from .errors import WorkerError

if TYPE_CHECKING:
    from pathlib import Path
    from types import TracebackType
    from typing import Self

FFMPEG_PATH: Final = "/usr/bin/ffmpeg"
READ_CHUNK_BYTES: Final = 1024 * 1024
MAX_READ_CHUNK_BYTES: Final = READ_CHUNK_BYTES
READ_STALL_TIMEOUT_SECONDS: Final = 60.0
PROCESS_EXIT_TIMEOUT_SECONDS: Final = 10.0
PROCESS_ABORT_TIMEOUT_SECONDS: Final = 5.0
MAX_DECODE_BYTES: Final = MAX_DURATION_SAMPLES * PCM_BYTES_PER_SAMPLE

INVALID_MEDIA: Final = "INVALID_MEDIA"
DURATION_LIMIT_EXCEEDED: Final = "DURATION_LIMIT_EXCEEDED"
TRANSCRIPTION_FAILED: Final = "TRANSCRIPTION_FAILED"


class PcmStream(Protocol):
    """Bounded byte stream produced by one decoder process."""

    def read(self, max_bytes: int) -> bytes:
        """Read at most the requested bytes, or return empty at EOF."""

    def finish(self) -> None:
        """Verify successful process exit after EOF."""

    def abort(self) -> None:
        """Terminate and reap the process idempotently."""


class ProcessPort(Protocol):
    """Small subprocess surface needed by the decoder."""

    stdout: BinaryIO | None

    def poll(self) -> int | None:
        """Return the current exit status."""

    def wait(self, timeout: float | None = None) -> int:
        """Wait for process termination."""

    def terminate(self) -> None:
        """Request graceful termination."""

    def kill(self) -> None:
        """Force process termination."""


ProcessFactory = Callable[[tuple[str, ...]], ProcessPort]
ReadableWaiter = Callable[[BinaryIO, float], bool]


class _PopenProcessAdapter:
    """Narrow the overly broad stdlib Popen stdout stub to binary mode."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process
        # Popen[bytes] is created without text mode, but typeshed exposes stdout as IO[Any].
        self.stdout = cast("BinaryIO | None", process.stdout)

    def poll(self) -> int | None:
        return self._process.poll()

    def wait(self, timeout: float | None = None) -> int:
        return self._process.wait(timeout=timeout)

    def terminate(self) -> None:
        self._process.terminate()

    def kill(self) -> None:
        self._process.kill()


def _spawn_ffmpeg(command: tuple[str, ...]) -> ProcessPort:
    process = subprocess.Popen(  # noqa: S603 - every argument is fixed or validated.
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
        start_new_session=True,
    )
    return _PopenProcessAdapter(process)


def _wait_until_readable(stream: BinaryIO, timeout_seconds: float) -> bool:
    readable, _, _ = select.select([stream], [], [], timeout_seconds)
    return bool(readable)


class FfmpegFloat32Stream:
    """Own one fixed FFmpeg process and expose only bounded stdout reads."""

    def __init__(
        self,
        source: Path,
        *,
        audio_stream_index: int,
        process_factory: ProcessFactory = _spawn_ffmpeg,
        wait_readable: ReadableWaiter = _wait_until_readable,
        stall_timeout_seconds: float = READ_STALL_TIMEOUT_SECONDS,
    ) -> None:
        """Validate the local source and start exactly one decoder process."""
        if (
            not source.is_absolute()
            or not source.is_relative_to("/tmp")  # noqa: S108 - fixed ephemeral root.
            or source.is_symlink()
            or not source.is_file()
            or isinstance(audio_stream_index, bool)
            or audio_stream_index < 0
            or stall_timeout_seconds <= 0
        ):
            raise WorkerError(INVALID_MEDIA)
        command = (
            FFMPEG_PATH,
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-i",
            str(source),
            "-map",
            f"0:{audio_stream_index}",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            "pipe:1",
        )
        try:
            process = process_factory(command)
        except OSError:
            raise WorkerError(INVALID_MEDIA) from None
        if process.stdout is None:
            self._terminate_unusable_process(process)
            raise WorkerError(INVALID_MEDIA)
        self._process = process
        self._stdout = process.stdout
        self._wait_readable = wait_readable
        self._stall_timeout_seconds = stall_timeout_seconds
        self._closed = False

    def read(self, max_bytes: int) -> bytes:
        """Read only when stdout is ready and normalize process stalls."""
        if self._closed or not 0 < max_bytes <= MAX_READ_CHUNK_BYTES:
            raise WorkerError(INVALID_MEDIA)
        try:
            readable = self._wait_readable(self._stdout, self._stall_timeout_seconds)
        except (OSError, ValueError):
            raise WorkerError(INVALID_MEDIA) from None
        if not readable:
            raise WorkerError(INVALID_MEDIA)
        try:
            return os.read(self._stdout.fileno(), max_bytes)
        except OSError:
            raise WorkerError(INVALID_MEDIA) from None

    def finish(self) -> None:
        """Close stdout and require a clean, bounded process exit."""
        if self._closed:
            return
        self._close_stdout()
        try:
            return_code = self._process.wait(timeout=PROCESS_EXIT_TIMEOUT_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            self._terminate_process()
            raise WorkerError(INVALID_MEDIA) from None
        self._closed = True
        if return_code != 0:
            raise WorkerError(INVALID_MEDIA)

    def abort(self) -> None:
        """Terminate, kill if needed, and reap without exposing native errors."""
        if self._closed:
            return
        self._close_stdout()
        self._terminate_process()
        self._closed = True

    def _close_stdout(self) -> None:
        with suppress(OSError):
            self._stdout.close()

    def _terminate_process(self) -> None:
        try:
            if self._process.poll() is not None:
                self._process.wait(timeout=PROCESS_ABORT_TIMEOUT_SECONDS)
                return
            self._process.terminate()
            try:
                self._process.wait(timeout=PROCESS_ABORT_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=PROCESS_ABORT_TIMEOUT_SECONDS)
            else:
                return
        except (OSError, subprocess.TimeoutExpired):
            return

    @staticmethod
    def _terminate_unusable_process(process: ProcessPort) -> None:
        try:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=PROCESS_ABORT_TIMEOUT_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
                process.wait(timeout=PROCESS_ABORT_TIMEOUT_SECONDS)
            except (OSError, subprocess.TimeoutExpired):
                return

    def __enter__(self) -> Self:
        """Return the active stream."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Abort unless the caller already verified a clean EOF."""
        del exc_type, exc_value, traceback
        self.abort()


@dataclass(frozen=True, slots=True)
class PcmWindow:
    """An ephemeral float32 PCM view valid only during the consumer callback."""

    spec: WindowSpec
    pcm: memoryview

    @property
    def size_bytes(self) -> int:
        """Return the exact inference input size."""
        return self.pcm.nbytes


@dataclass(frozen=True, slots=True)
class DecodeSummary:
    """Safe facts from one complete decoder stream."""

    total_samples: int
    duration_seconds: float
    window_count: int
    peak_buffer_bytes: int


@dataclass(slots=True)
class _DecodeState:
    buffer: bytearray
    buffer_start_sample: int = 0
    next_core_start: int = 0
    total_bytes: int = 0
    window_count: int = 0
    peak_buffer_bytes: int = 0

    def add_chunk(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        if self.total_bytes > MAX_DECODE_BYTES:
            raise WorkerError(DURATION_LIMIT_EXCEEDED)
        self.buffer.extend(chunk)
        self.peak_buffer_bytes = max(self.peak_buffer_bytes, len(self.buffer))

    def actual_total_samples(self) -> int:
        if self.total_bytes == 0 or self.total_bytes % PCM_BYTES_PER_SAMPLE != 0:
            raise WorkerError(INVALID_MEDIA)
        return self.total_bytes // PCM_BYTES_PER_SAMPLE

    def consume_ready(
        self,
        consume: Callable[[PcmWindow], None],
        *,
        is_eof: bool,
        total_samples: int | None = None,
    ) -> None:
        available_end_sample = self.buffer_start_sample + len(self.buffer) // PCM_BYTES_PER_SAMPLE
        while True:
            core_end = self.next_core_start + CORE_SAMPLES
            required_end = core_end + CONTEXT_SAMPLES
            if is_eof:
                if total_samples is None or self.next_core_start >= total_samples:
                    return
                core_end = min(core_end, total_samples)
                window_end = min(total_samples, core_end + CONTEXT_SAMPLES)
                is_last = core_end == total_samples
            else:
                if available_end_sample < required_end:
                    return
                window_end = required_end
                is_last = False
            window_start = max(0, self.next_core_start - CONTEXT_SAMPLES)
            start_offset = (window_start - self.buffer_start_sample) * PCM_BYTES_PER_SAMPLE
            end_offset = (window_end - self.buffer_start_sample) * PCM_BYTES_PER_SAMPLE
            if start_offset < 0 or end_offset > len(self.buffer):
                raise WorkerError(INVALID_MEDIA)
            spec = WindowSpec(
                index=self.next_core_start // CORE_SAMPLES,
                core_start_sample=self.next_core_start,
                core_end_sample=core_end,
                window_start_sample=window_start,
                window_end_sample=window_end,
                is_last=is_last,
            )
            view = memoryview(self.buffer)[start_offset:end_offset].toreadonly()
            try:
                consume(PcmWindow(spec=spec, pcm=view))
            finally:
                view.release()
            self.window_count += 1
            self.next_core_start = core_end
            keep_from = max(0, self.next_core_start - CONTEXT_SAMPLES)
            discard_bytes = (keep_from - self.buffer_start_sample) * PCM_BYTES_PER_SAMPLE
            if discard_bytes < 0 or discard_bytes > len(self.buffer):
                raise WorkerError(INVALID_MEDIA)
            del self.buffer[:discard_bytes]
            self.buffer_start_sample = keep_from
            available_end_sample = (
                self.buffer_start_sample + len(self.buffer) // PCM_BYTES_PER_SAMPLE
            )


def decode_pcm_windows(
    stream: PcmStream,
    consume: Callable[[PcmWindow], None],
    *,
    on_progress: Callable[[], None] | None = None,
    read_chunk_bytes: int = READ_CHUNK_BYTES,
) -> DecodeSummary:
    """Read one PCM stream and synchronously consume bounded overlapping windows."""
    if not 0 < read_chunk_bytes <= MAX_READ_CHUNK_BYTES:
        raise WorkerError(INVALID_MEDIA)
    state = _DecodeState(buffer=bytearray())
    finished = False
    try:
        _read_stream(
            stream,
            state,
            consume,
            read_chunk_bytes=read_chunk_bytes,
            on_progress=on_progress,
        )
        stream.finish()
        finished = True
        total_samples = state.actual_total_samples()
        state.consume_ready(
            consume,
            is_eof=True,
            total_samples=total_samples,
        )
        return DecodeSummary(
            total_samples=total_samples,
            duration_seconds=total_samples / SAMPLE_RATE,
            window_count=state.window_count,
            peak_buffer_bytes=state.peak_buffer_bytes,
        )
    except WorkerError:
        if not finished:
            stream.abort()
        raise
    except Exception:  # noqa: BLE001 - normalize callback and native stream boundaries.
        if not finished:
            stream.abort()
        raise WorkerError(TRANSCRIPTION_FAILED) from None


def _read_stream(
    stream: PcmStream,
    state: _DecodeState,
    consume: Callable[[PcmWindow], None],
    *,
    read_chunk_bytes: int,
    on_progress: Callable[[], None] | None,
) -> None:
    while True:
        chunk = stream.read(read_chunk_bytes)
        if not chunk:
            return
        if not isinstance(chunk, bytes) or len(chunk) > read_chunk_bytes:
            raise WorkerError(INVALID_MEDIA)
        state.add_chunk(chunk)
        if on_progress is not None:
            on_progress()
        state.consume_ready(consume, is_eof=False)


__all__ = [
    "FFMPEG_PATH",
    "MAX_DECODE_BYTES",
    "MAX_READ_CHUNK_BYTES",
    "READ_CHUNK_BYTES",
    "DecodeSummary",
    "FfmpegFloat32Stream",
    "PcmStream",
    "PcmWindow",
    "decode_pcm_windows",
]
