"""Tests for deterministic artifacts and manifest-last metadata."""

from __future__ import annotations

import hashlib
import json
from typing import Final

import pytest

from scribe_drop_worker.artifacts import (
    ResultArtifactKeys,
    build_artifact_bundle,
    extract_result_key,
)
from scribe_drop_worker.contracts import ResultManifest, TranscriptSegment
from scribe_drop_worker.errors import WorkerError
from scribe_drop_worker.transcription import TranscriptionResult

JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
OWNER_HASH: Final = "a" * 32
PREFIX: Final = f"results/{OWNER_HASH}/{JOB_ID}/{ATTEMPT_ID}/"


def transcription() -> TranscriptionResult:
    """Return a result containing markup and a line break."""
    return TranscriptionResult(
        language="ja",
        language_probability=0.99,
        duration_seconds=60.5,
        segments=(
            TranscriptSegment(
                id=0,
                start=1.25,
                end=2.5,
                text="<script>\ntranscript text",
            ),
        ),
    )


def test_bundle_has_generic_markdown_exact_json_srt_and_integrity_manifest() -> None:
    """Artifacts contain no user title and manifest hashes exact bytes."""
    bundle = build_artifact_bundle(
        job_id=JOB_ID,
        attempt_id=ATTEMPT_ID,
        transcription=transcription(),
        keys=ResultArtifactKeys(
            markdown=f"{PREFIX}transcript.md",
            json_artifact=f"{PREFIX}transcript.json",
            srt=f"{PREFIX}transcript.srt",
        ),
    )
    markdown = bundle.markdown.content.decode()
    assert markdown.startswith("# Transcript\n")
    assert "<script>" not in markdown
    assert "&lt;script&gt; transcript text" in markdown
    assert "00:00:01,250 --> 00:00:02,500" in bundle.srt.content.decode()

    manifest = ResultManifest.model_validate_json(bundle.manifest)
    assert manifest.complete is True
    assert (
        manifest.artifacts.json_artifact.sha256
        == hashlib.sha256(bundle.json_artifact.content).hexdigest()
    )
    transcript_json = json.loads(bundle.json_artifact.content)
    assert transcript_json["segments"][0]["text"] == "<script>\ntranscript text"


def test_result_key_is_derived_only_from_expected_path_style_capability() -> None:
    """Manifest keys cannot be redirected to another attempt or object."""
    valid = (
        f"https://storage.example.invalid/bucket/{PREFIX}transcript.json?X-Amz-Signature=redacted"
    )
    assert (
        extract_result_key(
            valid,
            job_id=JOB_ID,
            attempt_id=ATTEMPT_ID,
            filename="transcript.json",
        )
        == f"{PREFIX}transcript.json"
    )

    wrong = valid.replace(ATTEMPT_ID, JOB_ID)
    with pytest.raises(WorkerError) as failure:
        extract_result_key(
            wrong,
            job_id=JOB_ID,
            attempt_id=ATTEMPT_ID,
            filename="transcript.json",
        )
    assert failure.value.code == "INTERNAL_ERROR"
