"""Tests for the offline image integrity check."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from scribe_drop_worker.constants import DEFAULT_MODEL_PATH
from scribe_drop_worker.container_check import (
    EXPECTED_MODULES,
    EXPECTED_PACKAGES,
    ContainerCheckPorts,
    check_container_runtime,
)
from scribe_drop_worker.model_bundle import MODEL_FILE_SPECS, ModelBundleMetadata

if TYPE_CHECKING:
    from pathlib import Path


def _environment() -> dict[str, str]:
    return {
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_OFFLINE": "1",
        "MODEL_PATH": DEFAULT_MODEL_PATH,
        "TRANSFORMERS_OFFLINE": "1",
    }


def _bundle_verifier(_path: Path) -> ModelBundleMetadata:
    return ModelBundleMetadata.model_validate(
        {
            "repository": "dropbox-dash/faster-whisper-large-v3-turbo",
            "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
            "files": {name: spec.model_dump() for name, spec in MODEL_FILE_SPECS.items()},
        }
    )


def test_container_check_accepts_fixed_non_root_offline_runtime() -> None:
    """The image check imports dependencies without loading the GPU model."""
    imported: list[str] = []

    def import_module(name: str) -> object:
        imported.append(name)
        return object()

    check_container_runtime(
        _environment(),
        effective_uid=10_001,
        ports=ContainerCheckPorts(
            version_lookup=EXPECTED_PACKAGES.__getitem__,
            module_importer=import_module,
            bundle_verifier=_bundle_verifier,
            probe_version=lambda: "ffprobe version 6.1.1-3ubuntu5",
        ),
    )
    assert imported == list(EXPECTED_MODULES)


@pytest.mark.parametrize(
    ("effective_uid", "environment", "versions", "probe", "message"),
    [
        (0, _environment(), EXPECTED_PACKAGES, "ffprobe version 6.1.1", "root"),
        (
            10_001,
            {**_environment(), "HF_HUB_OFFLINE": "0"},
            EXPECTED_PACKAGES,
            "ffprobe version 6.1.1",
            "offline",
        ),
        (
            10_001,
            {**_environment(), "MODEL_PATH": "/opt/models/not-fixed"},
            EXPECTED_PACKAGES,
            "ffprobe version 6.1.1",
            "model path",
        ),
        (
            10_001,
            _environment(),
            {**EXPECTED_PACKAGES, "runpod": "0.0.0"},
            "ffprobe version 6.1.1",
            "dependency",
        ),
        (
            10_001,
            _environment(),
            EXPECTED_PACKAGES,
            "ffprobe version 7.0",
            "ffprobe",
        ),
    ],
)
def test_container_check_rejects_drift(
    effective_uid: int,
    environment: dict[str, str],
    versions: dict[str, str],
    probe: str,
    message: str,
) -> None:
    """Root execution, online fallback, and component drift fail closed."""
    with pytest.raises(RuntimeError, match=message):
        check_container_runtime(
            environment,
            effective_uid=effective_uid,
            ports=ContainerCheckPorts(
                version_lookup=versions.__getitem__,
                module_importer=lambda _name: object(),
                bundle_verifier=_bundle_verifier,
                probe_version=lambda: probe,
            ),
        )
