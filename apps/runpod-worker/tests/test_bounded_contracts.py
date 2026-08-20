"""Parity tests for the proposed execution and result contract v2."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from scribe_drop_worker.bounded_contracts import (
    ExecutionOptionsV2,
    ResultCapabilitiesV2,
    ResultManifestV2,
    canonicalize_output_formats,
)


def _fixture() -> dict[str, Any]:
    fixture_path = (
        Path(__file__).parents[3]
        / "packages"
        / "contracts"
        / "fixtures"
        / "bounded-execution-v2.json"
    )
    return TypeAdapter(dict[str, Any]).validate_python(
        json.loads(fixture_path.read_text(encoding="utf-8"))
    )


def test_shared_v2_fixture_is_strictly_validated() -> None:
    """The Python and TypeScript boundaries consume the same safe fixture."""
    fixture = _fixture()
    options = ExecutionOptionsV2.model_validate_json(json.dumps(fixture["options"]))
    capabilities = ResultCapabilitiesV2.model_validate_json(json.dumps(fixture["capabilities"]))
    manifest = ResultManifestV2.model_validate_json(json.dumps(fixture["manifest"]))

    assert options.output_formats == ("markdown", "json")
    assert options.vad is False
    assert tuple(item.format for item in capabilities.artifacts) == options.output_formats
    assert manifest.requested_formats == options.output_formats


@pytest.mark.parametrize(
    "formats",
    [(), ("json", "json"), ("json", "markdown"), ("markdown", "txt")],
)
def test_execution_options_reject_invalid_format_sets(formats: tuple[str, ...]) -> None:
    """Empty, duplicate, reordered, and unknown selections fail closed."""
    payload = {**_fixture()["options"], "outputFormats": formats}
    with pytest.raises(ValidationError):
        ExecutionOptionsV2.model_validate(payload)


def test_manifest_rejects_contract_guessing_and_artifact_drift() -> None:
    """A v2 attempt cannot accept v1, missing, extra, or reordered artifacts."""
    payload = _fixture()["manifest"]
    for replacement in (
        {"schemaVersion": 1},
        {"executionContractVersion": 1},
        {"artifacts": payload["artifacts"][:1]},
        {"artifacts": list(reversed(payload["artifacts"]))},
        {
            "artifacts": [
                {
                    **payload["artifacts"][0],
                    "key": payload["artifacts"][0]["key"].replace(
                        "transcript.md", "transcript.json"
                    ),
                },
                payload["artifacts"][1],
            ]
        },
        {
            "artifacts": [
                {
                    **artifact,
                    "key": artifact["key"].replace(
                        "01ARZ3NDEKTSV4RRFFQ69G5FAW",
                        "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                    ),
                }
                for artifact in payload["artifacts"]
            ]
        },
        {"token": "forbidden"},
    ):
        with pytest.raises(ValidationError):
            ResultManifestV2.model_validate({**payload, **replacement})


def test_canonicalize_output_formats_preserves_only_fixed_order() -> None:
    """Canonicalization is deterministic and rejects ambiguous selections."""
    assert canonicalize_output_formats(("srt", "markdown")) == ("markdown", "srt")
    with pytest.raises(ValueError, match="duplicates"):
        canonicalize_output_formats(("json", "json"))


@pytest.mark.parametrize(
    "url",
    [
        "http://storage.example.invalid/file",
        "https://user@storage.example.invalid/file",
        "https://storage.example.invalid:8443/file",
        "https://storage.example.invalid/file#fragment",
    ],
)
def test_v2_capabilities_reject_non_https_or_credentialed_urls(url: str) -> None:
    """Contract parity rejects unsafe URL syntax before the HTTP host policy."""
    payload = _fixture()["capabilities"]
    with pytest.raises(ValidationError):
        ResultCapabilitiesV2.model_validate({**payload, "manifestPutUrl": url})
