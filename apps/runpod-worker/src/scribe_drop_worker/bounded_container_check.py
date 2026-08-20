"""Offline maximum-duration check for the built bounded worker image."""

from __future__ import annotations

import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

from .bounded_artifacts import BoundedArtifactPublisher
from .bounded_decoder import MAX_DECODE_BYTES, READ_CHUNK_BYTES, decode_pcm_windows
from .bounded_inference import BoundedInferenceCoordinator
from .bounded_transcription import (
    MAX_WINDOW_BYTES,
    PCM_BYTES_PER_SAMPLE,
    PromptTail,
    SegmentSpool,
    WindowSegmentMerger,
)
from .cloud_run_bounded_gpu_benchmark import (
    DiscardingArtifactUpload,
    create_benchmark_options,
    create_benchmark_publication_plan,
)

if TYPE_CHECKING:
    from collections.abc import Iterable

BOUNDED_CONTAINER_CHECK_OK: Final = "bounded-container-check:ok\n"
EXPECTED_WINDOW_COUNT: Final = 32
EXPECTED_ARTIFACT_COUNT: Final = 3
DEFAULT_TEMPORARY_ROOT: Final = Path("/tmp")  # noqa: S108 - reviewed scratch mount.


@dataclass(frozen=True, slots=True)
class _NativeInfo:
    language: str = "en"
    language_probability: float = 1.0


class _EmptyWindowModel:
    """Consume every bounded view without retaining PCM or transcript content."""

    def __init__(self) -> None:
        self.call_count = 0

    def transcribe(
        self,
        audio: memoryview,
        **options: object,
    ) -> tuple[Iterable[object], object]:
        if not audio.readonly or audio.nbytes == 0 or options.get("vad_filter") is not False:
            raise ValueError
        self.call_count += 1
        return (), _NativeInfo()


class _VirtualMaximumPcmStream:
    """Generate exactly eight hours of zero PCM in caller-bounded chunks."""

    def __init__(self) -> None:
        self._remaining = MAX_DECODE_BYTES
        self.finished = False
        self.aborted = False

    def read(self, max_bytes: int) -> bytes:
        size = min(max_bytes, self._remaining)
        self._remaining -= size
        return bytes(size)

    def finish(self) -> None:
        self.finished = True

    def abort(self) -> None:
        self.aborted = True


def check_bounded_container_core(
    *,
    temporary_root: Path = DEFAULT_TEMPORARY_ROOT,
) -> None:
    """Exercise eight-hour decode, sequential windows, spool, artifacts, and cleanup."""
    model = _EmptyWindowModel()
    stream = _VirtualMaximumPcmStream()
    upload = DiscardingArtifactUpload()
    task_path: Path | None = None
    with tempfile.TemporaryDirectory(
        prefix="scribe-drop-bounded-container-check-",
        dir=temporary_root,
    ) as task_directory_value:
        task_path = Path(task_directory_value)
        prompt = PromptTail()
        with SegmentSpool(task_path) as spool:
            coordinator = BoundedInferenceCoordinator(
                model=model,
                options=create_benchmark_options(),
                merger=WindowSegmentMerger(spool, prompt),
                prompt=prompt,
            )
            summary = decode_pcm_windows(stream, coordinator.consume)
            language = coordinator.language_result
            publication = BoundedArtifactPublisher(task_path, upload).publish(
                create_benchmark_publication_plan(
                    language=language.language,
                    language_probability=language.probability,
                    duration_seconds=summary.duration_seconds,
                ),
                spool,
            )
            if (
                summary.total_samples * PCM_BYTES_PER_SAMPLE != MAX_DECODE_BYTES
                or summary.window_count != EXPECTED_WINDOW_COUNT
                or summary.peak_buffer_bytes > MAX_WINDOW_BYTES + READ_CHUNK_BYTES
                or model.call_count != EXPECTED_WINDOW_COUNT
                or spool.segment_count != 0
                or publication.artifact_count != EXPECTED_ARTIFACT_COUNT
                or upload.artifact_count != EXPECTED_ARTIFACT_COUNT
                or not upload.manifest_written
                or not stream.finished
                or stream.aborted
            ):
                msg = "bounded container invariant failed"
                raise RuntimeError(msg)
    if task_path is None or task_path.exists():
        msg = "bounded container cleanup failed"
        raise RuntimeError(msg)


def main() -> None:
    """Run the fixed offline check and emit no content-derived values."""
    check_bounded_container_core()
    sys.stdout.write(BOUNDED_CONTAINER_CHECK_OK)


if __name__ == "__main__":
    main()
