"""Sequential file-backed artifacts for the proposed bounded execution path."""

from __future__ import annotations

import hashlib
import html
import json
import os
import stat
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol

from pydantic import Field, field_validator, model_validator

from .bounded_contracts import (
    ARTIFACT_FILENAMES_V2,
    EXECUTION_CONTRACT_VERSION,
    RESULT_MANIFEST_SCHEMA_VERSION,
    ExecutionOptionsV2,
    HttpsCapabilityUrlV2,
    ManifestArtifactV2,
    OutputFormatV2,
    ResultManifestV3,
    ResultObjectKey,
    validate_https_capability_url,
)
from .constants import MAX_DURATION_SECONDS, MODEL_NAME, SCHEMA_VERSION
from .contracts import LanguageCode, StrictModel, Ulid
from .errors import WorkerError

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path
    from types import TracebackType
    from typing import BinaryIO, Self

    from .bounded_transcription import SegmentSpool

MAX_ARTIFACT_BYTES_V2: Final = 128 * 1024 * 1024
MAX_MANIFEST_BYTES_V2: Final = 64 * 1024
INTERNAL_ERROR: Final = "INTERNAL_ERROR"

CONTENT_TYPES: Final[dict[OutputFormatV2, str]] = {
    "markdown": "text/markdown; charset=utf-8",
    "json": "application/json",
    "srt": "application/x-subrip; charset=utf-8",
}


class TranscriptMetadataV2(StrictModel):
    """Validated attempt result facts used by each selected artifact."""

    language: LanguageCode
    language_probability: float = Field(alias="languageProbability", ge=0, le=1)
    duration_seconds: float = Field(alias="durationSeconds", gt=0, le=MAX_DURATION_SECONDS)


class ArtifactUploadTarget(StrictModel):
    """Validated URL and exact object key for one selected format."""

    format: OutputFormatV2
    key: ResultObjectKey
    put_url: HttpsCapabilityUrlV2 = Field(alias="putUrl")

    _validate_put_url = field_validator("put_url")(validate_https_capability_url)

    @model_validator(mode="after")
    def key_matches_format(self) -> ArtifactUploadTarget:
        """Reject a capability whose key extension disagrees with its format."""
        if not self.key.endswith(f"/{ARTIFACT_FILENAMES_V2[self.format]}"):
            msg = "artifact key does not match format"
            raise ValueError(msg)
        return self


class ArtifactPublicationPlan(StrictModel):
    """Complete selected-format publication input for one attempt."""

    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    options: ExecutionOptionsV2
    metadata: TranscriptMetadataV2
    targets: tuple[ArtifactUploadTarget, ...] = Field(min_length=1, max_length=3)
    manifest_put_url: HttpsCapabilityUrlV2 = Field(alias="manifestPutUrl")

    _validate_manifest_put_url = field_validator("manifest_put_url")(validate_https_capability_url)

    @model_validator(mode="after")
    def targets_match_snapshot_and_identity(self) -> ArtifactPublicationPlan:
        """Bind each exact object to the immutable selected format set."""
        target_formats = tuple(target.format for target in self.targets)
        if target_formats != self.options.output_formats:
            msg = "artifact targets do not match outputFormats"
            raise ValueError(msg)
        if any(
            not target.key.endswith(
                f"/{self.job_id}/{self.attempt_id}/{ARTIFACT_FILENAMES_V2[target.format]}"
            )
            for target in self.targets
        ):
            msg = "artifact target identity does not match the attempt"
            raise ValueError(msg)
        return self


class StreamingArtifactUploadPort(Protocol):
    """Future HTTP adapter boundary that never requires artifact bytes in memory."""

    def put_file(
        self,
        url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Upload one known-length regular file from its open descriptor."""

    def put_manifest(self, url: str, content: bytes) -> None:
        """Upload the small completion marker last."""


@dataclass(frozen=True, slots=True)
class PublishedResult:
    """Safe counters and the exact manifest produced by one publication."""

    manifest: ResultManifestV3
    artifact_count: int


@dataclass(frozen=True, slots=True)
class _RenderContext:
    plan: ArtifactPublicationPlan
    spool: SegmentSpool
    on_progress: Callable[[], None] | None


class _ArtifactFile:
    """Exclusive mode-0600 file with incremental size and digest enforcement."""

    def __init__(self, path: Path, *, max_bytes: int) -> None:
        self._path = path
        self._max_bytes = max_bytes
        self._size_bytes = 0
        self._sha256 = hashlib.sha256()
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags, 0o600)
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
    def size_bytes(self) -> int:
        return self._size_bytes

    @property
    def sha256(self) -> str:
        return self._sha256.hexdigest()

    @property
    def content(self) -> BinaryIO:
        try:
            self._file.flush()
            self._file.seek(0)
        except OSError:
            raise WorkerError(INTERNAL_ERROR) from None
        return self._file

    def write(self, content: bytes) -> None:
        if self._size_bytes + len(content) > self._max_bytes:
            raise WorkerError(INTERNAL_ERROR)
        try:
            written = self._file.write(content)
        except OSError:
            raise WorkerError(INTERNAL_ERROR) from None
        if written != len(content):
            raise WorkerError(INTERNAL_ERROR)
        self._sha256.update(content)
        self._size_bytes += len(content)

    def close(self) -> None:
        try:
            self._file.close()
        finally:
            try:
                self._path.unlink(missing_ok=True)
            except OSError:
                raise WorkerError(INTERNAL_ERROR) from None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.close()


class BoundedArtifactPublisher:
    """Generate, upload, and remove exactly one selected artifact at a time."""

    def __init__(
        self,
        task_directory: Path,
        upload: StreamingArtifactUploadPort,
        *,
        max_artifact_bytes: int = MAX_ARTIFACT_BYTES_V2,
    ) -> None:
        """Bind publication to one existing ephemeral task directory."""
        if (
            not task_directory.is_absolute()
            or not task_directory.is_relative_to("/tmp")  # noqa: S108 - task-local root.
            or task_directory.is_symlink()
            or not task_directory.is_dir()
            or not 0 < max_artifact_bytes <= MAX_ARTIFACT_BYTES_V2
        ):
            raise WorkerError(INTERNAL_ERROR)
        self._task_directory = task_directory
        self._upload = upload
        self._max_artifact_bytes = max_artifact_bytes

    def publish(
        self,
        plan: ArtifactPublicationPlan,
        spool: SegmentSpool,
        *,
        on_progress: Callable[[], None] | None = None,
    ) -> PublishedResult:
        """Publish the exact selected set and write its manifest only after success."""
        context = _RenderContext(plan=plan, spool=spool, on_progress=on_progress)
        manifest_artifacts: list[ManifestArtifactV2] = []
        for target in plan.targets:
            artifact_path = self._task_directory / f"artifact-{target.format}.tmp"
            with _ArtifactFile(
                artifact_path,
                max_bytes=self._max_artifact_bytes,
            ) as artifact:
                self._render(artifact, target.format, context)
                self._upload.put_file(
                    target.put_url,
                    artifact.content,
                    content_type=CONTENT_TYPES[target.format],
                    size_bytes=artifact.size_bytes,
                    sha256=artifact.sha256,
                )
                manifest_artifacts.append(
                    ManifestArtifactV2(
                        format=target.format,
                        key=target.key,
                        sha256=artifact.sha256,
                        sizeBytes=artifact.size_bytes,
                    )
                )
            if on_progress is not None:
                on_progress()
        manifest = ResultManifestV3(
            schemaVersion=RESULT_MANIFEST_SCHEMA_VERSION,
            executionContractVersion=EXECUTION_CONTRACT_VERSION,
            jobId=plan.job_id,
            attemptId=plan.attempt_id,
            complete=True,
            requestedLanguage=plan.options.language,
            detectedLanguage=plan.metadata.language,
            requestedFormats=plan.options.output_formats,
            artifacts=tuple(manifest_artifacts),
        )
        manifest_content = _json_line(manifest.model_dump(mode="json", by_alias=True))
        if len(manifest_content) > MAX_MANIFEST_BYTES_V2:
            raise WorkerError(INTERNAL_ERROR)
        self._upload.put_manifest(plan.manifest_put_url, manifest_content)
        return PublishedResult(manifest=manifest, artifact_count=len(manifest_artifacts))

    def _render(
        self,
        artifact: _ArtifactFile,
        format_: OutputFormatV2,
        context: _RenderContext,
    ) -> None:
        if format_ == "markdown":
            self._render_markdown(artifact, context)
        elif format_ == "json":
            self._render_json(artifact, context)
        else:
            self._render_srt(artifact, context)

    @staticmethod
    def _render_markdown(artifact: _ArtifactFile, context: _RenderContext) -> None:
        metadata = context.plan.metadata
        header = (
            "# Transcript\n\n"
            f"- Audio duration: {metadata.duration_seconds:.3f} seconds\n"
            f"- Detected language: {metadata.language}\n"
            f"- Model: {MODEL_NAME}\n\n"
            "## Transcript\n\n"
        ).encode()
        artifact.write(header)
        for segment in context.spool.iter_segments():
            artifact.write(
                f"[{_markdown_timestamp(segment.start)}] {_safe_text(segment.text)}\n".encode()
            )
            if context.on_progress is not None:
                context.on_progress()

    @staticmethod
    def _render_json(artifact: _ArtifactFile, context: _RenderContext) -> None:
        plan = context.plan
        metadata = plan.metadata
        prefix = _json_compact(
            {
                "attemptId": plan.attempt_id,
                "durationSeconds": metadata.duration_seconds,
                "jobId": plan.job_id,
                "language": metadata.language,
                "languageProbability": metadata.language_probability,
                "model": MODEL_NAME,
                "schemaVersion": SCHEMA_VERSION,
            }
        )
        artifact.write(prefix[:-1] + b',"segments":[')
        first = True
        for segment in context.spool.iter_segments():
            if not first:
                artifact.write(b",")
            artifact.write(_json_compact(segment.model_dump(mode="json")))
            first = False
            if context.on_progress is not None:
                context.on_progress()
        artifact.write(b"]}\n")

    @staticmethod
    def _render_srt(artifact: _ArtifactFile, context: _RenderContext) -> None:
        first = True
        for index, segment in enumerate(context.spool.iter_segments(), start=1):
            if not first:
                artifact.write(b"\n")
            artifact.write(
                (
                    f"{index}\n{_srt_timestamp(segment.start)} --> "
                    f"{_srt_timestamp(segment.end)}\n{_safe_text(segment.text)}\n"
                ).encode()
            )
            first = False
            if context.on_progress is not None:
                context.on_progress()


def _json_compact(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, UnicodeError, ValueError):
        raise WorkerError(INTERNAL_ERROR) from None


def _json_line(value: object) -> bytes:
    return _json_compact(value) + b"\n"


def _safe_text(value: str) -> str:
    return html.escape(" ".join(value.split()), quote=False)


def _markdown_timestamp(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, remaining_seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{remaining_seconds:02d}"


def _srt_timestamp(seconds: float) -> str:
    total_milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{milliseconds:03d}"


__all__ = [
    "MAX_ARTIFACT_BYTES_V2",
    "ArtifactPublicationPlan",
    "ArtifactUploadTarget",
    "BoundedArtifactPublisher",
    "PublishedResult",
    "StreamingArtifactUploadPort",
    "TranscriptMetadataV2",
]
