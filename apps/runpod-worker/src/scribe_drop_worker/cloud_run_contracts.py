"""Strict contracts for the synthetic Cloud Run one-shot runtime protocol."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Final, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from .bounded_artifacts import ArtifactUploadTarget  # noqa: TC001 - Pydantic resolves at runtime.
from .bounded_contracts import (
    ARTIFACT_FILENAMES_V2,
    ExecutionOptionsV2,
    HttpsCapabilityUrlV2,
    canonicalize_output_formats,
)
from .constants import MAX_DURATION_SECONDS
from .contracts import StrictModel, Ulid

CLOUD_RUN_RUNTIME_POLICY: Final = "cloud_run_jobs_l4_v1"

OpaqueHandle = Annotated[
    str,
    StringConstraints(
        pattern=r"^[A-Za-z0-9_-]{43}$",
        min_length=43,
        max_length=43,
        strict=True,
    ),
]
PublicKey = OpaqueHandle
SessionToken = OpaqueHandle
Challenge = OpaqueHandle
Ed25519Signature = Annotated[
    str,
    StringConstraints(
        pattern=r"^[A-Za-z0-9_-]{86}$",
        min_length=86,
        max_length=86,
        strict=True,
    ),
]
CloudRunResourceName = Annotated[
    str,
    StringConstraints(
        pattern=r"^[a-z][a-z0-9-]*(?:[a-z0-9])$",
        min_length=1,
        max_length=63,
        strict=True,
    ),
]
GoogleIdentityToken = Annotated[
    str,
    StringConstraints(
        pattern=r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$",
        min_length=100,
        max_length=8192,
        strict=True,
    ),
]
RuntimeEnvironment = Literal["staging", "production"]
RuntimeProgress = Literal["bootstrap", "download", "transcribe", "publish"]
RuntimeErrorCode = Literal[
    "BOOTSTRAP_REJECTED",
    "SESSION_REJECTED",
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


def _validate_utc_timestamp(value: str) -> str:
    if not value.endswith("Z"):
        msg = "timestamp must end in Z"
        raise ValueError(msg)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        msg = "timestamp must be ISO-8601"
        raise ValueError(msg) from error
    if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        msg = "timestamp must be UTC"
        raise ValueError(msg)
    return value


class RuntimeIdentity(StrictModel):
    """Cloud Run built-in identity and opaque controller binding."""

    bootstrap_request_id: Ulid = Field(alias="bootstrapRequestId")
    environment: RuntimeEnvironment
    execution_handle: OpaqueHandle = Field(alias="executionHandle")
    execution_name: CloudRunResourceName = Field(alias="executionName")
    job_name: CloudRunResourceName = Field(alias="jobName")
    policy_id: Literal["cloud_run_jobs_l4_v1"] = Field(alias="policyId")
    public_key: PublicKey = Field(alias="publicKey")
    task_attempt: Literal[0] = Field(alias="taskAttempt")
    task_count: Literal[1] = Field(alias="taskCount")
    task_index: Literal[0] = Field(alias="taskIndex")


class BootstrapRequest(RuntimeIdentity):
    """Initial identity proof sent before any application capability exists."""

    identity_token: GoogleIdentityToken = Field(alias="identityToken")


class BootstrapResponse(StrictModel):
    """Durably replayable challenge bound to one bootstrap digest."""

    challenge: Challenge
    challenge_id: Ulid = Field(alias="challengeId")
    expires_at: str = Field(alias="expiresAt")

    _validate_expiry = field_validator("expires_at")(_validate_utc_timestamp)


class ClaimRequest(StrictModel):
    """Ephemeral-key proof that consumes one bootstrap challenge."""

    bootstrap_request_id: Ulid = Field(alias="bootstrapRequestId")
    challenge_id: Ulid = Field(alias="challengeId")
    environment: RuntimeEnvironment
    execution_handle: OpaqueHandle = Field(alias="executionHandle")
    execution_name: CloudRunResourceName = Field(alias="executionName")
    job_name: CloudRunResourceName = Field(alias="jobName")
    policy_id: Literal["cloud_run_jobs_l4_v1"] = Field(alias="policyId")
    signature: Ed25519Signature
    task_attempt: Literal[0] = Field(alias="taskAttempt")
    task_count: Literal[1] = Field(alias="taskCount")
    task_index: Literal[0] = Field(alias="taskIndex")


class RuntimeSession(StrictModel):
    """Short-lived session issued with synthetic capabilities."""

    expires_at: str = Field(alias="expiresAt")
    session_id: Ulid = Field(alias="sessionId")
    token: SessionToken

    _validate_expiry = field_validator("expires_at")(_validate_utc_timestamp)


class RuntimeResultCapabilities(StrictModel):
    """Selected exact-object targets plus the manifest-last capability."""

    artifacts: tuple[ArtifactUploadTarget, ...] = Field(min_length=1, max_length=3)
    manifest_put_url: HttpsCapabilityUrlV2 = Field(alias="manifestPutUrl")

    @model_validator(mode="after")
    def require_canonical_artifacts(self) -> RuntimeResultCapabilities:
        """Reject duplicate or reordered result targets."""
        formats = tuple(artifact.format for artifact in self.artifacts)
        if formats != canonicalize_output_formats(formats):
            msg = "artifact capabilities must use canonical unique formats"
            raise ValueError(msg)
        return self


class RuntimeSourceCapability(StrictModel):
    """Read-only exact source capability with immutable expectations."""

    get_url: HttpsCapabilityUrlV2 = Field(alias="getUrl")
    expected_size_bytes: int = Field(alias="expectedSizeBytes", gt=0, le=2 * 1024 * 1024 * 1024)
    expected_etag: str = Field(alias="expectedEtag", min_length=1, max_length=512)


class ClaimResponse(StrictModel):
    """Exact attempt, options, capabilities, and session for one runtime."""

    attempt_id: Ulid = Field(alias="attemptId")
    job_id: Ulid = Field(alias="jobId")
    options: ExecutionOptionsV2
    results: RuntimeResultCapabilities
    session: RuntimeSession
    source: RuntimeSourceCapability

    @model_validator(mode="after")
    def capabilities_match_attempt(self) -> ClaimResponse:
        """Bind selected targets to the immutable options and exact attempt."""
        formats = tuple(artifact.format for artifact in self.results.artifacts)
        if formats != self.options.output_formats or any(
            not artifact.key.endswith(
                f"/{self.job_id}/{self.attempt_id}/{ARTIFACT_FILENAMES_V2[artifact.format]}"
            )
            for artifact in self.results.artifacts
        ):
            msg = "artifact capabilities must match the exact attempt options"
            raise ValueError(msg)
        return self


class AuthenticatedRuntimeRequest(StrictModel):
    """Common session-authenticated request fields."""

    execution_handle: OpaqueHandle = Field(alias="executionHandle")
    sequence: int = Field(ge=0)
    session_id: Ulid = Field(alias="sessionId")
    session_token: SessionToken = Field(alias="sessionToken")


class AckRequest(AuthenticatedRuntimeRequest):
    """Confirm that the exact claim response was received."""

    state: Literal["ready"]


class AckResponse(StrictModel):
    """Bounded acknowledgement result."""

    acknowledged: Literal[True]


class HeartbeatRequest(AuthenticatedRuntimeRequest):
    """Monotonic runtime liveness update."""

    progress: RuntimeProgress


class HeartbeatResponse(StrictModel):
    """Cancellation decision for the active session."""

    cancel_requested: bool = Field(alias="cancelRequested")


class TerminalRequest(AuthenticatedRuntimeRequest):
    """Terminal report that does not imply provider cleanup."""

    artifact_count: int = Field(alias="artifactCount", ge=0, le=3)
    duration_seconds: float = Field(alias="durationSeconds", ge=0, le=MAX_DURATION_SECONDS)
    error_code: RuntimeErrorCode | None = Field(alias="errorCode")
    manifest_written: bool = Field(alias="manifestWritten")
    segment_count: int = Field(alias="segmentCount", ge=0, le=100_000)
    status: Literal["succeeded", "failed", "cancelled"]

    @model_validator(mode="after")
    def terminal_fields_match_status(self) -> TerminalRequest:
        """Reject success without manifest and failure without a safe error."""
        if self.status == "succeeded":
            valid = self.artifact_count > 0 and self.error_code is None and self.manifest_written
        else:
            valid = self.error_code is not None and not self.manifest_written
        if not valid:
            msg = "terminal fields do not match status"
            raise ValueError(msg)
        return self


class TerminalResponse(StrictModel):
    """Acknowledge report persistence while cleanup remains pending."""

    accepted: Literal[True]
    cleanup_pending: Literal[True] = Field(alias="cleanupPending")


__all__ = [
    "CLOUD_RUN_RUNTIME_POLICY",
    "AckRequest",
    "AckResponse",
    "BootstrapRequest",
    "BootstrapResponse",
    "ClaimRequest",
    "ClaimResponse",
    "HeartbeatRequest",
    "HeartbeatResponse",
    "RuntimeErrorCode",
    "RuntimeIdentity",
    "RuntimeProgress",
    "RuntimeResultCapabilities",
    "RuntimeSession",
    "RuntimeSourceCapability",
    "TerminalRequest",
    "TerminalResponse",
]
