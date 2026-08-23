"""Strict, offline-only contracts for the proposed bounded execution path."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Final, Literal
from urllib.parse import urlsplit

from pydantic import Field, StringConstraints, field_validator, model_validator

from .constants import MAX_URL_LENGTH
from .contracts import LanguageCode, Sha256Hex, StrictModel, Ulid

if TYPE_CHECKING:
    from collections.abc import Iterable

EXECUTION_CONTRACT_VERSION: Final = 2
RESULT_MANIFEST_SCHEMA_VERSION: Final = 3
OutputFormatV2 = Literal["markdown", "json", "srt"]
ExecutionLanguageV2 = Literal["ja", "en", "auto"]
CANONICAL_OUTPUT_FORMATS: Final[tuple[OutputFormatV2, ...]] = ("markdown", "json", "srt")
ARTIFACT_FILENAMES_V2: Final[dict[OutputFormatV2, str]] = {
    "markdown": "transcript.md",
    "json": "transcript.json",
    "srt": "transcript.srt",
}
HttpsCapabilityUrlV2 = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_URL_LENGTH, strict=True),
]
ResultObjectKey = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=1024,
        pattern=r"^results/[0-9a-f]{32}/[0-9A-HJKMNP-TV-Z]{26}/"
        r"[0-9A-HJKMNP-TV-Z]{26}/transcript\.(?:md|json|srt)$",
        strict=True,
    ),
]


def canonicalize_output_formats(values: Iterable[OutputFormatV2]) -> tuple[OutputFormatV2, ...]:
    """Return the fixed output order while rejecting empty or duplicate selections."""
    selected = tuple(values)
    if not selected or len(selected) > len(CANONICAL_OUTPUT_FORMATS):
        msg = "output formats must contain between one and three values"
        raise ValueError(msg)
    if len(frozenset(selected)) != len(selected):
        msg = "output formats must not contain duplicates"
        raise ValueError(msg)
    return tuple(value for value in CANONICAL_OUTPUT_FORMATS if value in selected)


def validate_https_capability_url(value: str) -> str:
    """Require credential-free HTTPS syntax before the adapter applies its host policy."""
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        msg = "capability URL port is invalid"
        raise ValueError(msg) from None
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.fragment
    ):
        msg = "capability URL must be credential-free HTTPS on port 443"
        raise ValueError(msg)
    return value


class ExecutionOptionsV2(StrictModel):
    """Immutable options snapshot proposed for one provider execution."""

    contract_version: Literal[2] = Field(alias="contractVersion")
    language: ExecutionLanguageV2
    model: Literal["large-v3-turbo"]
    output_formats: tuple[OutputFormatV2, ...] = Field(
        alias="outputFormats",
        min_length=1,
        max_length=3,
    )
    vad: bool

    @model_validator(mode="after")
    def require_canonical_formats(self) -> ExecutionOptionsV2:
        """Reject snapshots whose ordering was not canonicalized by the owner."""
        if self.output_formats != canonicalize_output_formats(self.output_formats):
            msg = "outputFormats must use canonical order"
            raise ValueError(msg)
        return self


class ArtifactCapabilityV2(StrictModel):
    """One selected exact-object artifact capability."""

    format: OutputFormatV2
    put_url: HttpsCapabilityUrlV2 = Field(alias="putUrl")

    _validate_put_url = field_validator("put_url")(validate_https_capability_url)


class ResultCapabilitiesV2(StrictModel):
    """Only requested artifact capabilities plus the manifest capability."""

    artifacts: tuple[ArtifactCapabilityV2, ...] = Field(min_length=1, max_length=3)
    manifest_put_url: HttpsCapabilityUrlV2 = Field(alias="manifestPutUrl")

    _validate_manifest_put_url = field_validator("manifest_put_url")(validate_https_capability_url)

    @model_validator(mode="after")
    def require_canonical_unique_artifacts(self) -> ResultCapabilitiesV2:
        """Prevent duplicate, reordered, or ambiguous selected capabilities."""
        formats = tuple(artifact.format for artifact in self.artifacts)
        if formats != canonicalize_output_formats(formats):
            msg = "artifact capabilities must use canonical unique formats"
            raise ValueError(msg)
        return self


class ManifestArtifactV2(StrictModel):
    """Integrity metadata for one selected result object."""

    format: OutputFormatV2
    key: ResultObjectKey
    sha256: Sha256Hex
    size_bytes: int = Field(alias="sizeBytes", ge=0, le=128 * 1024 * 1024)


class ResultManifestV3(StrictModel):
    """Completion marker for an exact execution contract v2 option set."""

    schema_version: Literal[3] = Field(alias="schemaVersion")
    execution_contract_version: Literal[2] = Field(alias="executionContractVersion")
    job_id: Ulid = Field(alias="jobId")
    attempt_id: Ulid = Field(alias="attemptId")
    complete: Literal[True]
    requested_language: ExecutionLanguageV2 = Field(alias="requestedLanguage")
    detected_language: LanguageCode = Field(alias="detectedLanguage")
    requested_formats: tuple[OutputFormatV2, ...] = Field(
        alias="requestedFormats",
        min_length=1,
        max_length=3,
    )
    artifacts: tuple[ManifestArtifactV2, ...] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def require_exact_artifact_set(self) -> ResultManifestV3:
        """Bind the manifest to the exact language and canonical format set."""
        if self.requested_language not in {"auto", self.detected_language}:
            msg = "detectedLanguage must match a fixed requestedLanguage"
            raise ValueError(msg)
        requested = canonicalize_output_formats(self.requested_formats)
        artifact_formats = tuple(artifact.format for artifact in self.artifacts)
        if self.requested_formats != requested or artifact_formats != requested:
            msg = "manifest artifacts must exactly match requestedFormats"
            raise ValueError(msg)
        if any(
            not artifact.key.endswith(
                f"/{self.job_id}/{self.attempt_id}/{ARTIFACT_FILENAMES_V2[artifact.format]}"
            )
            for artifact in self.artifacts
        ):
            msg = "manifest artifact key does not match its attempt and format"
            raise ValueError(msg)
        return self


__all__ = [
    "ARTIFACT_FILENAMES_V2",
    "CANONICAL_OUTPUT_FORMATS",
    "EXECUTION_CONTRACT_VERSION",
    "RESULT_MANIFEST_SCHEMA_VERSION",
    "ArtifactCapabilityV2",
    "ExecutionOptionsV2",
    "HttpsCapabilityUrlV2",
    "ManifestArtifactV2",
    "OutputFormatV2",
    "ResultCapabilitiesV2",
    "ResultManifestV3",
    "canonicalize_output_formats",
    "validate_https_capability_url",
]
