"""Contract parity tests for the TypeScript and Python worker boundaries."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from scribe_drop_worker.contracts import (
    CLAIM_RESPONSE_ADAPTER,
    RunpodClaimDeduplicated,
    RunpodJobEnvelope,
    RunpodWorkerInput,
    TranscriptSegment,
)

JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
TOKEN = "A" * 43


def test_worker_input_rejects_unknown_fields_and_coercion() -> None:
    """The minimal RunPod input must remain exact and strict."""
    valid = {
        "schemaVersion": 1,
        "jobId": JOB_ID,
        "attemptId": ATTEMPT_ID,
        "claimToken": TOKEN,
    }
    parsed = RunpodWorkerInput.model_validate(valid)
    assert parsed.job_id == JOB_ID

    with pytest.raises(ValidationError):
        RunpodWorkerInput.model_validate({**valid, "sourceUrl": "https://example.invalid"})
    with pytest.raises(ValidationError):
        RunpodWorkerInput.model_validate({**valid, "schemaVersion": "1"})


def test_runpod_envelope_ignores_provider_metadata_but_not_input_metadata() -> None:
    """RunPod may extend its envelope, but it cannot extend product input."""
    parsed = RunpodJobEnvelope.model_validate(
        {
            "id": "runpod-job",
            "input": {
                "schemaVersion": 1,
                "jobId": JOB_ID,
                "attemptId": ATTEMPT_ID,
                "claimToken": TOKEN,
            },
            "providerMetadata": {"ignored": True},
        }
    )
    assert parsed.id == "runpod-job"


def test_claim_response_is_a_strict_discriminated_shape() -> None:
    """Capabilities and duplicate responses reject undeclared fields."""
    deduplicated = CLAIM_RESPONSE_ADAPTER.validate_python({"deduplicated": True})
    assert isinstance(deduplicated, RunpodClaimDeduplicated)
    assert deduplicated.deduplicated is True

    with pytest.raises(ValidationError):
        CLAIM_RESPONSE_ADAPTER.validate_python(
            {"deduplicated": True, "getUrl": "https://storage.example.invalid/source"}
        )


@pytest.mark.parametrize(
    "expires_at",
    [
        "2026-07-25T00:00:00+09:00",
        "not-a-timestampZ",
        "2026-07-25T00:00:00+01:00Z",
    ],
)
def test_claim_expiry_requires_a_valid_utc_z_timestamp(expires_at: str) -> None:
    """Capability expiry follows the strict cross-language UTC representation."""
    response = {
        "granted": True,
        "source": {
            "getUrl": "https://source.example.invalid/object?signature=redacted",
            "expectedSizeBytes": 1024,
            "expectedEtag": "etag",
        },
        "results": {
            "markdownPutUrl": "https://result.example.invalid/transcript.md?signature=redacted",
            "jsonPutUrl": "https://result.example.invalid/transcript.json?signature=redacted",
            "srtPutUrl": "https://result.example.invalid/transcript.srt?signature=redacted",
            "manifestPutUrl": "https://result.example.invalid/manifest.json?signature=redacted",
        },
        "heartbeat": {
            "url": "https://hooks.example.invalid/internal/runpod/heartbeat",
            "token": TOKEN,
        },
        "expiresAt": expires_at,
    }
    with pytest.raises(ValidationError):
        CLAIM_RESPONSE_ADAPTER.validate_python(response)


def test_transcript_segment_rejects_reversed_boundaries() -> None:
    """Segment timing must be monotonic."""
    with pytest.raises(ValidationError, match="must not precede"):
        TranscriptSegment.model_validate({"id": 0, "start": 2.0, "end": 1.0, "text": "safe"})
