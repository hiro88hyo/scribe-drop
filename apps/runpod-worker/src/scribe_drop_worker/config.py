"""Strict environment parsing for the RunPod worker."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .constants import DEFAULT_MODEL_PATH, MAX_DURATION_SECONDS, MAX_SOURCE_BYTES

if TYPE_CHECKING:
    from collections.abc import Mapping

MAX_HOSTNAME_LENGTH = 253


class WorkerSettings(BaseModel):
    """Validated non-secret worker configuration."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    app_environment: Literal["local", "staging", "production"]
    orchestrator_origin: str
    source_hosts: frozenset[str]
    result_hosts: frozenset[str]
    max_source_bytes: int = Field(gt=0, le=MAX_SOURCE_BYTES)
    max_duration_seconds: float = Field(gt=0, le=MAX_DURATION_SECONDS)
    heartbeat_interval_seconds: float = Field(ge=30, le=120)
    model_path: str

    @model_validator(mode="after")
    def validate_production_model_path(self) -> WorkerSettings:
        """Prevent staging and production from selecting a runtime model location."""
        if self.app_environment != "local" and self.model_path != DEFAULT_MODEL_PATH:
            msg = "MODEL_PATH is fixed outside local development"
            raise ValueError(msg)
        return self

    @field_validator("orchestrator_origin")
    @classmethod
    def validate_origin(cls, value: str) -> str:
        """Require one exact HTTPS origin with no path or credentials."""
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.path not in ("", "/")
            or parsed.query != ""
            or parsed.fragment != ""
        ):
            msg = "ORCHESTRATOR_ORIGIN must be an exact HTTPS origin"
            raise ValueError(msg)
        return f"https://{_canonical_hostname(parsed.hostname)}"

    @field_validator("source_hosts", "result_hosts")
    @classmethod
    def validate_hosts(cls, values: frozenset[str]) -> frozenset[str]:
        """Canonicalize and reject empty or wildcard allowlists."""
        if not values:
            msg = "host allowlist must not be empty"
            raise ValueError(msg)
        return frozenset(_canonical_hostname(value) for value in values)

    @field_validator("model_path")
    @classmethod
    def validate_model_path(cls, value: str) -> str:
        """Require an absolute preloaded model path."""
        if not value.startswith("/") or ".." in value.split("/"):
            msg = "MODEL_PATH must be an absolute normalized path"
            raise ValueError(msg)
        return value

    @property
    def orchestrator_host(self) -> str:
        """Return the canonical host used for claim and heartbeat."""
        hostname = urlsplit(self.orchestrator_origin).hostname
        if hostname is None:  # pragma: no cover - guarded by model validation
            raise AssertionError
        return hostname

    @property
    def claim_url(self) -> str:
        """Return the fixed claim endpoint."""
        return f"{self.orchestrator_origin}/internal/runpod/claim"


def _canonical_hostname(value: str) -> str:
    candidate = value.strip().rstrip(".").lower()
    if (
        not candidate
        or candidate == "*"
        or "*" in candidate
        or "/" in candidate
        or ":" in candidate
        or "@" in candidate
    ):
        msg = "host allowlist entries must be exact hostnames"
        raise ValueError(msg)
    try:
        canonical = candidate.encode("idna").decode("ascii")
    except UnicodeError as error:
        msg = "host allowlist entry is invalid"
        raise ValueError(msg) from error
    if len(canonical) > MAX_HOSTNAME_LENGTH:
        msg = "host allowlist entry is too long"
        raise ValueError(msg)
    return canonical


def _required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name)
    if value is None or value.strip() == "":
        msg = f"{name} is required"
        raise ValueError(msg)
    return value.strip()


def _parse_hosts(value: str) -> frozenset[str]:
    return frozenset(part.strip() for part in value.split(",") if part.strip())


def load_settings(environment: Mapping[str, str]) -> WorkerSettings:
    """Validate worker settings without retaining the original environment mapping."""
    return WorkerSettings.model_validate(
        {
            "app_environment": _required(environment, "APP_ENV"),
            "orchestrator_origin": _required(environment, "ORCHESTRATOR_ORIGIN"),
            "source_hosts": _parse_hosts(_required(environment, "ALLOWED_SOURCE_HOSTS")),
            "result_hosts": _parse_hosts(_required(environment, "ALLOWED_RESULT_HOSTS")),
            "max_source_bytes": int(environment.get("MAX_SOURCE_BYTES", str(MAX_SOURCE_BYTES))),
            "max_duration_seconds": float(
                environment.get("MAX_DURATION_SECONDS", str(MAX_DURATION_SECONDS))
            ),
            "heartbeat_interval_seconds": float(
                environment.get("HEARTBEAT_INTERVAL_SECONDS", "120")
            ),
            "model_path": environment.get("MODEL_PATH", DEFAULT_MODEL_PATH),
        }
    )
