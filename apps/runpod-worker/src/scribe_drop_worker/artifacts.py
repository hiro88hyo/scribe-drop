"""Deterministic transcript artifacts and manifest integrity metadata."""

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal
from urllib.parse import unquote, urlsplit

from .constants import MODEL_NAME, SCHEMA_VERSION
from .contracts import (
    ManifestArtifact,
    ManifestArtifacts,
    ResultManifest,
    TranscriptJson,
)
from .errors import WorkerError

if TYPE_CHECKING:
    from .transcription import TranscriptionResult

INTERNAL_ERROR: Final = "INTERNAL_ERROR"
MAX_ARTIFACT_BYTES: Final = 512 * 1024 * 1024
ArtifactKind = Literal["json", "markdown", "srt"]


@dataclass(frozen=True, slots=True)
class Artifact:
    """One immutable upload payload and its integrity metadata."""

    kind: ArtifactKind
    key: str
    content_type: str
    content: bytes
    sha256: str

    @property
    def size_bytes(self) -> int:
        """Return the exact byte count included in the manifest."""
        return len(self.content)

    def manifest_entry(self) -> ManifestArtifact:
        """Build the cross-system artifact metadata."""
        return ManifestArtifact(
            key=self.key,
            sha256=self.sha256,
            sizeBytes=self.size_bytes,
        )


@dataclass(frozen=True, slots=True)
class ArtifactBundle:
    """Three required artifacts and the completion marker."""

    markdown: Artifact
    json_artifact: Artifact
    srt: Artifact
    manifest: bytes


@dataclass(frozen=True, slots=True)
class ResultArtifactKeys:
    """Exact result keys derived from the claim-issued URLs."""

    markdown: str
    json_artifact: str
    srt: str


def build_artifact_bundle(
    *,
    job_id: str,
    attempt_id: str,
    transcription: TranscriptionResult,
    keys: ResultArtifactKeys,
) -> ArtifactBundle:
    """Render deterministic UTF-8 outputs and a manifest written later."""
    transcript_json = TranscriptJson(
        schemaVersion=SCHEMA_VERSION,
        jobId=job_id,
        attemptId=attempt_id,
        language=transcription.language,
        languageProbability=transcription.language_probability,
        durationSeconds=transcription.duration_seconds,
        model=MODEL_NAME,
        segments=transcription.segments,
    )
    json_content = _json_bytes(transcript_json.model_dump(mode="json", by_alias=True))
    markdown_content = _markdown_bytes(transcription)
    srt_content = _srt_bytes(transcription)
    artifacts = (
        _artifact("markdown", keys.markdown, "text/markdown; charset=utf-8", markdown_content),
        _artifact("json", keys.json_artifact, "application/json", json_content),
        _artifact("srt", keys.srt, "application/x-subrip; charset=utf-8", srt_content),
    )
    manifest = ResultManifest(
        schemaVersion=SCHEMA_VERSION,
        jobId=job_id,
        attemptId=attempt_id,
        complete=True,
        artifacts=ManifestArtifacts(
            markdown=artifacts[0].manifest_entry(),
            json=artifacts[1].manifest_entry(),
            srt=artifacts[2].manifest_entry(),
        ),
    )
    return ArtifactBundle(
        markdown=artifacts[0],
        json_artifact=artifacts[1],
        srt=artifacts[2],
        manifest=_json_bytes(manifest.model_dump(mode="json", by_alias=True)),
    )


def extract_result_key(
    url: str,
    *,
    job_id: str,
    attempt_id: str,
    filename: Literal["manifest.json", "transcript.json", "transcript.md", "transcript.srt"],
) -> str:
    """Recover and verify the exact R2 key encoded in a path-style signed URL."""
    decoded_path = unquote(urlsplit(url).path)
    pattern = re.compile(
        rf"^/[a-z0-9][a-z0-9.-]{{1,62}}/"
        rf"(results/[0-9a-f]{{32}}/{re.escape(job_id)}/{re.escape(attempt_id)}/"
        rf"{re.escape(filename)})$"
    )
    match = pattern.fullmatch(decoded_path)
    if match is None or "%" in decoded_path or ".." in decoded_path.split("/"):
        raise WorkerError(INTERNAL_ERROR)
    return match.group(1)


def _artifact(kind: ArtifactKind, key: str, content_type: str, content: bytes) -> Artifact:
    if len(content) > MAX_ARTIFACT_BYTES:
        raise WorkerError(INTERNAL_ERROR)
    return Artifact(
        kind=kind,
        key=key,
        content_type=content_type,
        content=content,
        sha256=hashlib.sha256(content).hexdigest(),
    )


def _json_bytes(value: object) -> bytes:
    content = (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )
    if len(content) > MAX_ARTIFACT_BYTES:
        raise WorkerError(INTERNAL_ERROR)
    return content


def _markdown_bytes(transcription: TranscriptionResult) -> bytes:
    lines = [
        "# Transcript",
        "",
        f"- Audio duration: {transcription.duration_seconds:.3f} seconds",
        f"- Detected language: {transcription.language}",
        f"- Model: {MODEL_NAME}",
        "",
        "## Transcript",
        "",
    ]
    lines.extend(
        f"[{_markdown_timestamp(segment.start)}] {_safe_text(segment.text)}"
        for segment in transcription.segments
    )
    return ("\n".join(lines) + "\n").encode()


def _srt_bytes(transcription: TranscriptionResult) -> bytes:
    entries = [
        f"{index}\n{_srt_timestamp(segment.start)} --> {_srt_timestamp(segment.end)}\n"
        f"{_safe_text(segment.text)}"
        for index, segment in enumerate(transcription.segments, start=1)
    ]
    return ("\n\n".join(entries) + ("\n" if entries else "")).encode()


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
