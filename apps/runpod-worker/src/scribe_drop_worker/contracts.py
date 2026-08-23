"""Strict Pydantic models for every RunPod worker boundary."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationInfo,
    field_validator,
)

from .constants import MAX_DURATION_SECONDS, MAX_SOURCE_BYTES, MAX_URL_LENGTH

Ulid = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9A-HJKMNP-TV-Z]{26}$", strict=True),
]
CapabilityToken = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9_-]{43}$", min_length=43, max_length=43, strict=True),
]
RunpodJobId = Annotated[str, StringConstraints(min_length=1, max_length=200, strict=True)]
CapabilityUrl = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_URL_LENGTH, strict=True)
]
Sha256Hex = Annotated[
    str,
    StringConstraints(pattern=r"^[a-f0-9]{64}$", min_length=64, max_length=64, strict=True),
]
LanguageCode = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z]{2,3}$", min_length=2, max_length=3, strict=True),
]


class StrictModel(BaseModel):
    """Base model that rejects coercion and unknown fields."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class RunpodWorkerInput(StrictModel):
    """Minimal input submitted to the RunPod endpoint."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    claim_token: CapabilityToken = Field(alias="claimToken")


class RunpodJobEnvelope(BaseModel):
    """RunPod-owned envelope containing the untrusted worker input.

    RunPod can add envelope metadata over time. Only ``id`` and ``input`` are consumed,
    while the nested product input remains strict.
    """

    model_config = ConfigDict(extra="ignore", frozen=True, strict=True)

    id: RunpodJobId
    input: RunpodWorkerInput


class RunpodClaimRequest(StrictModel):
    """One-time claim request."""

    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    runpod_job_id: RunpodJobId = Field(alias="runpodJobId")
    claim_token: CapabilityToken = Field(alias="claimToken")


class SourceCapability(StrictModel):
    """Read-only capability and immutable source expectations."""

    get_url: CapabilityUrl = Field(alias="getUrl")
    expected_size_bytes: int = Field(alias="expectedSizeBytes", gt=0, le=MAX_SOURCE_BYTES)
    expected_etag: str = Field(alias="expectedEtag", min_length=1, max_length=512)


class ResultCapabilities(StrictModel):
    """Exact-object write capabilities for worker artifacts."""

    markdown_put_url: CapabilityUrl = Field(alias="markdownPutUrl")
    json_put_url: CapabilityUrl = Field(alias="jsonPutUrl")
    srt_put_url: CapabilityUrl = Field(alias="srtPutUrl")
    manifest_put_url: CapabilityUrl = Field(alias="manifestPutUrl")


class HeartbeatCapability(StrictModel):
    """Winner-bound heartbeat capability."""

    url: CapabilityUrl
    token: CapabilityToken


RunpodExecutionLanguage = Literal["ja", "en", "auto"]
RunpodOutputFormat = Literal["markdown", "json", "srt"]


class RunpodExecutionOptions(StrictModel):
    """Immutable contract-v1 options attached to a winning RunPod claim."""

    contract_version: Literal[1] = Field(alias="contractVersion")
    language: RunpodExecutionLanguage
    model: Literal["large-v3-turbo"]
    output_formats: tuple[RunpodOutputFormat, ...] = Field(
        alias="outputFormats",
        min_length=1,
        max_length=3,
    )
    vad: bool

    @field_validator("output_formats")
    @classmethod
    def output_formats_are_unique(
        cls, value: tuple[RunpodOutputFormat, ...]
    ) -> tuple[RunpodOutputFormat, ...]:
        """Reject an ambiguous legacy snapshot before inference starts."""
        if len(set(value)) != len(value):
            msg = "outputFormats must not contain duplicates"
            raise ValueError(msg)
        return value


class RunpodClaimGranted(StrictModel):
    """Capabilities issued only to the winning RunPod job."""

    granted: Literal[True]
    options: RunpodExecutionOptions
    source: SourceCapability
    results: ResultCapabilities
    heartbeat: HeartbeatCapability
    expires_at: str = Field(alias="expiresAt")

    @field_validator("expires_at")
    @classmethod
    def validate_utc_expiry(cls, value: str) -> str:
        """Require the same UTC ISO-8601 representation as the TypeScript contract."""
        if not value.endswith("Z"):
            msg = "expiresAt must end in Z"
            raise ValueError(msg)
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as error:
            msg = "expiresAt must be a valid ISO-8601 timestamp"
            raise ValueError(msg) from error
        if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
            msg = "expiresAt must be UTC"
            raise ValueError(msg)
        return value


class RunpodClaimDeduplicated(StrictModel):
    """Expected response for a losing duplicate submission."""

    deduplicated: Literal[True]


ClaimResponse = RunpodClaimGranted | RunpodClaimDeduplicated
CLAIM_RESPONSE_ADAPTER: TypeAdapter[ClaimResponse] = TypeAdapter(ClaimResponse)


class RunpodHeartbeatRequest(StrictModel):
    """Winner-bound heartbeat request."""

    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    runpod_job_id: RunpodJobId = Field(alias="runpodJobId")
    heartbeat_token: CapabilityToken = Field(alias="heartbeatToken")


class RunpodHeartbeatResponse(StrictModel):
    """Cancellation state returned by the Orchestrator."""

    cancel_requested: bool = Field(alias="cancelRequested")


class TranscriptSegment(StrictModel):
    """Serializable transcription segment."""

    id: int = Field(ge=0)
    start: float = Field(ge=0, le=MAX_DURATION_SECONDS)
    end: float = Field(ge=0, le=MAX_DURATION_SECONDS)
    text: str

    @field_validator("end")
    @classmethod
    def end_does_not_precede_start(cls, value: float, info: ValidationInfo) -> float:
        """Validate ordering after strict numeric validation."""
        start = info.data.get("start")
        if isinstance(start, int | float) and value < start:
            msg = "segment end must not precede start"
            raise ValueError(msg)
        return value


class TranscriptJson(StrictModel):
    """Canonical transcript JSON artifact."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    language: LanguageCode
    language_probability: float = Field(alias="languageProbability", ge=0, le=1)
    duration_seconds: float = Field(alias="durationSeconds", ge=0, le=MAX_DURATION_SECONDS)
    model: Literal["large-v3-turbo"]
    segments: tuple[TranscriptSegment, ...]


class ManifestArtifact(StrictModel):
    """Integrity metadata for one result object."""

    key: str = Field(min_length=1, max_length=1024, pattern=r"^results/")
    sha256: Sha256Hex
    size_bytes: int = Field(alias="sizeBytes", ge=0)


class ManifestArtifacts(StrictModel):
    """Required result objects."""

    markdown: ManifestArtifact
    json_artifact: ManifestArtifact = Field(alias="json")
    srt: ManifestArtifact


class ResultManifest(StrictModel):
    """Completion marker written after all result artifacts."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    complete: Literal[True]
    artifacts: ManifestArtifacts


WorkerErrorCode = Literal[
    "CLAIM_REJECTED",
    "SOURCE_DOWNLOAD_FAILED",
    "SOURCE_SIZE_MISMATCH",
    "SOURCE_ETAG_MISMATCH",
    "INVALID_MEDIA",
    "DURATION_LIMIT_EXCEEDED",
    "TRANSCRIPTION_FAILED",
    "ARTIFACT_UPLOAD_FAILED",
    "MANIFEST_UPLOAD_FAILED",
    "CANCELLED",
    "INTERNAL_ERROR",
]


class WorkerCompletedOutput(StrictModel):
    """Allowlisted successful RunPod output."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    status: Literal["completed"]
    duration_seconds: float = Field(alias="durationSeconds", ge=0, le=MAX_DURATION_SECONDS)
    detected_language: Annotated[
        str,
        StringConstraints(pattern=r"^[A-Za-z0-9-]+$", min_length=2, max_length=35, strict=True),
    ] = Field(alias="detectedLanguage")
    segment_count: int = Field(alias="segmentCount", ge=0)
    manifest_written: Literal[True] = Field(alias="manifestWritten")


class WorkerFailedOutput(StrictModel):
    """Allowlisted failed or cancelled RunPod output."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    status: Literal["failed", "cancelled"]
    error_code: WorkerErrorCode = Field(alias="errorCode")
    manifest_written: Literal[False] = Field(alias="manifestWritten")


class WorkerDeduplicatedOutput(StrictModel):
    """Allowlisted duplicate RunPod output."""

    schema_version: Literal[1] = Field(alias="schemaVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    status: Literal["deduplicated"]
    manifest_written: Literal[False] = Field(alias="manifestWritten")
