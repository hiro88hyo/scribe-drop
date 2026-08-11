"""Cross-language parity for the Cloud Run one-shot runtime protocol."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from scribe_drop_worker.cloud_run_contracts import (
    BootstrapRequest,
    BootstrapResponse,
    ClaimRequest,
    ClaimResponse,
    TerminalRequest,
)


def _fixture() -> dict[str, Any]:
    fixture_path = (
        Path(__file__).parents[3]
        / "packages"
        / "contracts"
        / "fixtures"
        / "cloud-run-runtime-v1.json"
    )
    return TypeAdapter(dict[str, Any]).validate_python(
        json.loads(fixture_path.read_text(encoding="utf-8"))
    )


def test_shared_runtime_fixture_is_strictly_validated() -> None:
    """Python and TypeScript consume the same identity and capability fields."""
    fixture = _fixture()
    bootstrap = BootstrapRequest.model_validate(fixture["bootstrapRequest"])
    challenge = BootstrapResponse.model_validate(fixture["bootstrapResponse"])
    claim = ClaimRequest.model_validate(fixture["claimRequest"])
    response = ClaimResponse.model_validate_json(json.dumps(fixture["claimResponse"]))

    assert bootstrap.task_attempt == 0
    assert bootstrap.task_count == 1
    assert challenge.challenge_id == claim.challenge_id
    assert response.options.output_formats == ("markdown", "json")


@pytest.mark.parametrize(
    "replacement",
    [
        {"taskAttempt": 1},
        {"taskCount": 2},
        {"policyId": "runpod_serverless_v1"},
        {"executionHandle": "short"},
        {"identityToken": "not-a-jwt"},
        {"image": "caller-controlled"},
    ],
)
def test_bootstrap_rejects_provider_and_spec_drift(replacement: dict[str, object]) -> None:
    """Only provider-returned fields that Cloud Run actually exposes are accepted."""
    with pytest.raises(ValidationError):
        BootstrapRequest.model_validate({**_fixture()["bootstrapRequest"], **replacement})


def test_terminal_contract_preserves_partial_failure_without_claiming_completion() -> None:
    """Partial artifacts remain observable while manifest-less failure stays terminal."""
    terminal = TerminalRequest.model_validate(
        {
            "executionHandle": "h" * 43,
            "sequence": 4,
            "sessionId": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
            "sessionToken": "t" * 43,
            "artifactCount": 1,
            "durationSeconds": 10,
            "errorCode": "ARTIFACT_UPLOAD_FAILED",
            "manifestWritten": False,
            "segmentCount": 3,
            "status": "failed",
        }
    )
    assert terminal.artifact_count == 1
    with pytest.raises(ValidationError):
        TerminalRequest.model_validate(
            {
                **terminal.model_dump(mode="json", by_alias=True),
                "status": "succeeded",
                "errorCode": None,
            }
        )
