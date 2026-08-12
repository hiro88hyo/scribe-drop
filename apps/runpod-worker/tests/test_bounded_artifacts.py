"""Tests for sequential selected-format artifacts and manifest-last publication."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pytest
from pydantic import ValidationError

from scribe_drop_worker.bounded_artifacts import (
    MAX_ARTIFACT_BYTES_V2,
    ArtifactPublicationPlan,
    ArtifactUploadTarget,
    BoundedArtifactPublisher,
    TranscriptMetadataV2,
)
from scribe_drop_worker.bounded_contracts import (
    ExecutionOptionsV2,
    OutputFormatV2,
    ResultManifestV2,
)
from scribe_drop_worker.bounded_transcription import SegmentSpool
from scribe_drop_worker.errors import WorkerError

if TYPE_CHECKING:
    from typing import BinaryIO

JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
OWNER_HASH: Final = "a" * 32
PREFIX: Final = f"results/{OWNER_HASH}/{JOB_ID}/{ATTEMPT_ID}/"
MANIFEST_URL: Final = "https://storage.example.invalid/manifest.json?signature=dummy"
SECURE_FILE_MODE: Final = 0o600
EXPECTED_SELECTED_ARTIFACTS: Final = 2
ARTIFACT_UPLOAD_FAILED: Final = "ARTIFACT_UPLOAD_FAILED"


@dataclass
class ObservedUpload:
    """Safe test observation for one file upload."""

    url: str
    content_type: str
    content: bytes
    size_bytes: int
    sha256: str
    mode: int


@dataclass
class FakeStreamingUpload:
    """Record file uploads and optionally fail before manifest publication."""

    fail_at: int | None = None
    operations: list[str] = field(default_factory=list)
    files: list[ObservedUpload] = field(default_factory=list)
    manifest: bytes | None = None

    def put_file(
        self,
        url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Read from the open regular descriptor like a streaming HTTP adapter."""
        index = len(self.files) + 1
        self.operations.append(f"file:{index}")
        if self.fail_at == index:
            raise WorkerError(ARTIFACT_UPLOAD_FAILED)
        file_info = stat.S_ISREG(os_fstat_mode(content))
        assert file_info is True
        payload = content.read()
        self.files.append(
            ObservedUpload(
                url=url,
                content_type=content_type,
                content=payload,
                size_bytes=size_bytes,
                sha256=sha256,
                mode=stat.S_IMODE(os_fstat_mode(content)),
            )
        )

    def put_manifest(self, url: str, content: bytes) -> None:
        """Record the final operation."""
        assert url == MANIFEST_URL
        self.operations.append("manifest")
        self.manifest = content


def os_fstat_mode(content: BinaryIO) -> int:
    """Return mode without exposing the task-local path."""
    return os.fstat(content.fileno()).st_mode


def _options(*formats: OutputFormatV2) -> ExecutionOptionsV2:
    return ExecutionOptionsV2.model_validate(
        {
            "contractVersion": 2,
            "language": "ja",
            "model": "large-v3-turbo",
            "outputFormats": formats,
            "vad": False,
        }
    )


def _target(format_: OutputFormatV2) -> ArtifactUploadTarget:
    suffix = {"markdown": "md", "json": "json", "srt": "srt"}[format_]
    return ArtifactUploadTarget.model_validate(
        {
            "format": format_,
            "key": f"{PREFIX}transcript.{suffix}",
            "putUrl": f"https://storage.example.invalid/transcript.{suffix}?signature=dummy",
        }
    )


def _metadata() -> TranscriptMetadataV2:
    return TranscriptMetadataV2(
        language="ja",
        languageProbability=0.99,
        durationSeconds=60.5,
    )


def _plan(
    *formats: OutputFormatV2,
    targets: tuple[ArtifactUploadTarget, ...] | None = None,
) -> ArtifactPublicationPlan:
    selected_targets = targets or tuple(_target(format_) for format_ in formats)
    return ArtifactPublicationPlan.model_validate(
        {
            "jobId": JOB_ID,
            "attemptId": ATTEMPT_ID,
            "options": _options(*formats),
            "metadata": _metadata(),
            "targets": selected_targets,
            "manifestPutUrl": MANIFEST_URL,
        }
    )


def test_selected_artifacts_stream_sequentially_and_manifest_is_last(tmp_path: Path) -> None:
    """Only markdown and JSON exist, upload, disappear, then enter manifest v2."""
    upload = FakeStreamingUpload()
    progress = 0

    def on_progress() -> None:
        nonlocal progress
        progress += 1

    with SegmentSpool(tmp_path) as spool:
        spool.append(start=1.25, end=2.5, text="<script>\nraw text")
        spool.append(start=3.0, end=4.0, text="二番目")
        publisher = BoundedArtifactPublisher(tmp_path, upload)
        result = publisher.publish(
            _plan("markdown", "json"),
            spool=spool,
            on_progress=on_progress,
        )
        assert not tuple(tmp_path.glob("artifact-*.tmp"))

    assert upload.operations == ["file:1", "file:2", "manifest"]
    assert result.artifact_count == EXPECTED_SELECTED_ARTIFACTS
    assert upload.manifest is not None
    manifest = ResultManifestV2.model_validate_json(upload.manifest)
    assert manifest.requested_formats == ("markdown", "json")
    assert tuple(item.format for item in manifest.artifacts) == ("markdown", "json")
    assert all(item.mode == SECURE_FILE_MODE for item in upload.files)
    assert all(item.size_bytes == len(item.content) for item in upload.files)
    assert all(item.sha256 == hashlib.sha256(item.content).hexdigest() for item in upload.files)
    assert b"&lt;script&gt; raw text" in upload.files[0].content
    transcript = json.loads(upload.files[1].content)
    assert transcript["segments"][0]["text"] == "<script>\nraw text"
    assert progress > 0


@pytest.mark.parametrize("format_", ["markdown", "json", "srt"])
def test_each_single_selected_format_is_supported(
    tmp_path: Path,
    format_: OutputFormatV2,
) -> None:
    """A one-format attempt receives no capability or artifact for other formats."""
    upload = FakeStreamingUpload()
    with SegmentSpool(tmp_path) as spool:
        spool.append(start=0.0, end=1.0, text="text")
        result = BoundedArtifactPublisher(tmp_path, upload).publish(
            _plan(format_),
            spool=spool,
        )
    assert result.artifact_count == 1
    assert len(upload.files) == 1
    assert result.manifest.requested_formats == (format_,)


def test_target_drift_fails_before_file_or_manifest() -> None:
    """Extra, missing, or reordered targets never create an output file."""
    upload = FakeStreamingUpload()
    with pytest.raises(ValidationError):
        _plan(
            "markdown",
            "json",
            targets=(_target("json"), _target("markdown")),
        )
    assert upload.operations == []


def test_capabilities_reject_format_extension_and_attempt_identity_drift() -> None:
    """A valid URL cannot authorize the wrong format or attempt object key."""
    with pytest.raises(ValidationError):
        ArtifactUploadTarget.model_validate(
            {
                "format": "json",
                "key": f"{PREFIX}transcript.md",
                "putUrl": "https://storage.example.invalid/transcript.json?signature=dummy",
            }
        )

    wrong_attempt = ArtifactUploadTarget.model_validate(
        {
            "format": "json",
            "key": f"results/{OWNER_HASH}/{JOB_ID}/{JOB_ID}/transcript.json",
            "putUrl": "https://storage.example.invalid/transcript.json?signature=dummy",
        }
    )
    with pytest.raises(ValidationError):
        _plan("json", targets=(wrong_attempt,))


def test_publisher_rejects_non_task_root_and_invalid_limit(tmp_path: Path) -> None:
    """Artifacts can only be generated below the bounded task-local root."""
    upload = FakeStreamingUpload()
    with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
        BoundedArtifactPublisher(Path("relative-task"), upload)
    with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
        BoundedArtifactPublisher(tmp_path, upload, max_artifact_bytes=0)


def test_artifact_limit_and_upload_failure_leave_no_manifest_or_temp_file(
    tmp_path: Path,
) -> None:
    """Partial generation and response failures remove current local artifacts."""
    upload = FakeStreamingUpload()
    with SegmentSpool(tmp_path) as spool:
        spool.append(start=0.0, end=1.0, text="long enough")
        publisher = BoundedArtifactPublisher(tmp_path, upload, max_artifact_bytes=8)
        with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
            publisher.publish(
                _plan("markdown"),
                spool=spool,
            )
        assert not tuple(tmp_path.glob("artifact-*.tmp"))

    failed_upload = FakeStreamingUpload(fail_at=1)
    other = tmp_path / "other"
    other.mkdir()
    with SegmentSpool(other) as spool:
        spool.append(start=0.0, end=1.0, text="text")
        with pytest.raises(WorkerError, match="ARTIFACT_UPLOAD_FAILED"):
            BoundedArtifactPublisher(other, failed_upload).publish(
                _plan("srt"),
                spool=spool,
            )
        assert not tuple(other.glob("artifact-*.tmp"))
    assert failed_upload.manifest is None
    assert MAX_ARTIFACT_BYTES_V2 == 128 * 1024 * 1024


def test_existing_symlink_is_never_followed_or_overwritten(tmp_path: Path) -> None:
    """Exclusive no-follow creation protects foreign task-local paths."""
    foreign = tmp_path / "foreign"
    foreign.write_text("keep", encoding="utf-8")
    (tmp_path / "artifact-markdown.tmp").symlink_to(foreign)
    upload = FakeStreamingUpload()
    with (
        SegmentSpool(tmp_path) as spool,
        pytest.raises(WorkerError, match="INTERNAL_ERROR"),
    ):
        BoundedArtifactPublisher(tmp_path, upload).publish(
            _plan("markdown"),
            spool=spool,
        )
    assert foreign.read_text(encoding="utf-8") == "keep"
    assert upload.operations == []


def test_srt_streams_multiple_segments_with_deterministic_timestamps(tmp_path: Path) -> None:
    """SRT numbering, spacing, timestamps, and text normalization are deterministic."""
    upload = FakeStreamingUpload()
    with SegmentSpool(tmp_path) as spool:
        spool.append(start=0.001, end=1.999, text="first\nline")
        spool.append(start=3661.5, end=3662.0, text="second")
        BoundedArtifactPublisher(tmp_path, upload).publish(_plan("srt"), spool=spool)
    assert upload.files[0].content == (
        b"1\n00:00:00,001 --> 00:00:01,999\nfirst line\n\n"
        b"2\n01:01:01,500 --> 01:01:02,000\nsecond\n"
    )
