"""Tests for official RunPod SDK process startup."""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, Final

from scribe_drop_worker.config import load_settings
from scribe_drop_worker.entrypoint import main

if TYPE_CHECKING:
    import pytest

EXPECTED_CONFIGURATION_KEYS: Final = {"handler"}


def test_main_starts_official_serverless_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    """Process startup validates configuration before registering one handler."""
    settings = load_settings(
        {
            "APP_ENV": "local",
            "ORCHESTRATOR_ORIGIN": "https://hooks.example.invalid",
            "ALLOWED_SOURCE_HOSTS": "storage.example.invalid",
            "ALLOWED_RESULT_HOSTS": "storage.example.invalid",
        }
    )
    observed: list[dict[str, object]] = []
    serverless = SimpleNamespace(start=observed.append)
    module = SimpleNamespace(serverless=serverless)
    monkeypatch.setattr("scribe_drop_worker.entrypoint.load_settings", lambda _env: settings)
    monkeypatch.setattr(
        "scribe_drop_worker.entrypoint.importlib.import_module",
        lambda _name: module,
    )
    main()
    assert len(observed) == 1
    assert set(observed[0]) == EXPECTED_CONFIGURATION_KEYS
    assert callable(observed[0]["handler"])
