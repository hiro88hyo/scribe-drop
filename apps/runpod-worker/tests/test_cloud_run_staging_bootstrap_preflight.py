"""Tests for the GPU-free live bootstrap preflight entrypoint."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import httpx
import pytest

from scribe_drop_worker.cloud_run_errors import OneShotRuntimeError
from scribe_drop_worker.cloud_run_staging_bootstrap_preflight import (
    PREFLIGHT_FAILED,
    PREFLIGHT_OK,
    main,
    run_staging_bootstrap_preflight,
)
from scribe_drop_worker.one_shot import load_one_shot_environment

if TYPE_CHECKING:
    from collections.abc import Mapping

TOKEN = "a" * 100 + "." + "b" * 100 + "." + "c" * 100


class _Identity:
    def token(self, audience: str) -> str:
        assert audience == "https://orchestrator.example.invalid/internal/cloud-run/bootstrap"
        return TOKEN

    def close(self) -> None:
        pass


def _environment(**changes: str) -> dict[str, str]:
    values = {
        "APP_ENV": "staging",
        "CLOUD_RUN_EXECUTION": "sd-stg-preflight-execution",
        "CLOUD_RUN_JOB": "sd-stg-preflight-job",
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": "/opt/models/large-v3-turbo",
        "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        "SCRIBE_DROP_EXECUTION_HANDLE": "h" * 43,
        "SCRIBE_DROP_EXECUTION_POLICY": "cloud_run_jobs_l4_v1",
        "SCRIBE_DROP_IDENTITY_AUDIENCE": (
            "https://orchestrator.example.invalid/internal/cloud-run/bootstrap"
        ),
        "SCRIBE_DROP_ORCHESTRATOR_ORIGIN": "https://orchestrator.example.invalid",
        "SCRIBE_DROP_RESULT_HOST": "storage.example.invalid",
        "SCRIBE_DROP_SOURCE_HOST": "storage.example.invalid",
    }
    return {**values, **changes}


def _transport(status: int, body: bytes, content_type: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["identityToken"] == TOKEN
        assert request.url.path == "/internal/cloud-run/bootstrap"
        return httpx.Response(status, content=body, headers={"content-type": content_type})

    return httpx.MockTransport(handler)


def _run(status: int, body: bytes, content_type: str = "application/json") -> None:
    run_staging_bootstrap_preflight(
        load_one_shot_environment(_environment()),
        identity=_Identity(),
        transport=_transport(status, body, content_type),
    )


def test_accepts_only_authenticated_missing_execution_context() -> None:
    """Accept only the missing-context response reached after valid Google identity."""
    _run(
        404,
        b'{"error":{"code":"EXECUTION_NOT_FOUND","message":"Runtime request was rejected."}}',
    )


@pytest.mark.parametrize(
    ("status", "body", "content_type"),
    [
        (403, b"error code: 1010\n", "text/plain"),
        (
            403,
            b'{"error":{"code":"RESOURCE_DRIFT","message":"Runtime request was rejected."}}',
            "application/json",
        ),
        (
            403,
            b'{"error":{"code":"AUTHENTICATION_FAILED","message":"Runtime request was rejected."}}',
            "application/json",
        ),
        (500, b'{"error":{"code":"SESSION_REJECTED"}}', "application/json"),
    ],
)
def test_rejects_edge_blocks_and_pre_attestation_failures(
    status: int,
    body: bytes,
    content_type: str,
) -> None:
    """Reject edge responses and application failures before attestation."""
    with pytest.raises(OneShotRuntimeError):
        _run(status, body, content_type)


def test_refuses_production() -> None:
    """Prevent the staging-only probe from becoming a production bypass."""
    settings = load_one_shot_environment(_environment(APP_ENV="production"))
    with pytest.raises(OneShotRuntimeError):
        run_staging_bootstrap_preflight(
            settings,
            identity=_Identity(),
            transport=_transport(403, b"{}", "application/json"),
        )


def test_process_boundary_emits_only_fixed_markers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Keep process output fixed and free of request or identity material."""

    def identity() -> _Identity:
        return _Identity()

    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_staging_bootstrap_preflight.MetadataIdentityClient",
        identity,
    )
    monkeypatch.setattr(
        "scribe_drop_worker.cloud_run_staging_bootstrap_preflight._create_transport",
        lambda _settings: _transport(
            404,
            b'{"error":{"code":"EXECUTION_NOT_FOUND","message":"Runtime request was rejected."}}',
            "application/json",
        ),
    )
    main(_environment())
    assert capsys.readouterr().out == PREFLIGHT_OK

    invalid: Mapping[str, str] = {}
    with pytest.raises(SystemExit):
        main(invalid)
    assert capsys.readouterr().err == PREFLIGHT_FAILED
