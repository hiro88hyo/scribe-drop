"""Tests for strict worker environment configuration."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from scribe_drop_worker.config import load_settings


def valid_environment() -> dict[str, str]:
    """Return non-secret local settings."""
    return {
        "APP_ENV": "local",
        "ORCHESTRATOR_ORIGIN": "https://hooks.example.invalid",
        "ALLOWED_SOURCE_HOSTS": "source.example.invalid",
        "ALLOWED_RESULT_HOSTS": "result.example.invalid",
        "MAX_SOURCE_BYTES": "1024",
        "MAX_DURATION_SECONDS": "60",
        "HEARTBEAT_INTERVAL_SECONDS": "120",
        "MODEL_PATH": "/opt/models/large-v3-turbo",
    }


def test_settings_build_fixed_claim_url_and_exact_hosts() -> None:
    """Only a fixed origin and exact host entries are accepted."""
    settings = load_settings(valid_environment())
    assert settings.claim_url == "https://hooks.example.invalid/internal/runpod/claim"
    assert settings.orchestrator_host == "hooks.example.invalid"
    assert settings.source_hosts == frozenset({"source.example.invalid"})


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ORCHESTRATOR_ORIGIN", "http://hooks.example.invalid"),
        ("ORCHESTRATOR_ORIGIN", "https://user@hooks.example.invalid"),
        ("ORCHESTRATOR_ORIGIN", "https://hooks.example.invalid/path"),
        ("ALLOWED_SOURCE_HOSTS", "*.example.invalid"),
        ("ALLOWED_RESULT_HOSTS", "result.example.invalid:443"),
        ("MODEL_PATH", "../models/latest"),
    ],
)
def test_settings_reject_ambiguous_network_and_model_configuration(name: str, value: str) -> None:
    """Wildcards, URL credentials, paths, and floating model locations fail closed."""
    environment = valid_environment()
    environment[name] = value
    with pytest.raises((ValidationError, ValueError)):
        load_settings(environment)


def test_non_local_settings_require_the_fixed_image_model_path() -> None:
    """A deployment cannot select or download another model at runtime."""
    environment = valid_environment()
    environment["APP_ENV"] = "staging"
    environment["MODEL_PATH"] = "/opt/models/other-model"
    with pytest.raises(ValidationError, match="fixed"):
        load_settings(environment)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("APP_ENV", ""),
        ("ALLOWED_SOURCE_HOSTS", ""),
        ("ALLOWED_RESULT_HOSTS", f"{'a' * 250}.invalid"),
        ("ALLOWED_RESULT_HOSTS", "\ud800.invalid"),
    ],
)
def test_settings_reject_missing_and_invalid_allowlist_values(name: str, value: str) -> None:
    """Required settings and DNS host syntax fail closed."""
    environment = valid_environment()
    environment[name] = value
    with pytest.raises((ValidationError, ValueError)):
        load_settings(environment)
