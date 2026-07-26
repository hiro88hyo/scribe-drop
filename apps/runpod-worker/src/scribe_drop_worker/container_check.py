"""Offline integrity and runtime checks for the built worker image."""

from __future__ import annotations

import importlib
import importlib.metadata
import os
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .constants import DEFAULT_MODEL_PATH
from .model_bundle import ModelBundleMetadata, verify_model_bundle

EXPECTED_PACKAGES: Final[dict[str, str]] = {
    "ctranslate2": "4.8.1",
    "faster-whisper": "1.2.1",
    "huggingface-hub": "1.24.0",
    "httpx": "0.28.1",
    "pydantic": "2.13.4",
    "runpod": "1.11.0",
}
EXPECTED_MODULES: Final = (
    "ctranslate2",
    "faster_whisper",
    "httpx",
    "pydantic",
    "runpod",
)
OFFLINE_FLAGS: Final = (
    "HF_DATASETS_OFFLINE",
    "HF_HUB_OFFLINE",
    "TRANSFORMERS_OFFLINE",
)
FFPROBE_VERSION_MARKER: Final = "ffprobe version 6.1.1"

VersionLookup = Callable[[str], str]
ModuleImporter = Callable[[str], object]
BundleVerifier = Callable[[Path], ModelBundleMetadata]
ProbeVersion = Callable[[], str]


def _read_ffprobe_version() -> str:
    process = subprocess.run(
        ["/usr/bin/ffprobe", "-version"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    if process.returncode != 0:
        msg = "ffprobe version check failed"
        raise RuntimeError(msg)
    return process.stdout.splitlines()[0] if process.stdout else ""


@dataclass(frozen=True)
class ContainerCheckPorts:
    """Replaceable read-only boundaries used by the image check."""

    version_lookup: VersionLookup = importlib.metadata.version
    module_importer: ModuleImporter = importlib.import_module
    bundle_verifier: BundleVerifier = verify_model_bundle
    probe_version: ProbeVersion = _read_ffprobe_version


DEFAULT_CHECK_PORTS: Final = ContainerCheckPorts()


def check_container_runtime(
    environment: Mapping[str, str],
    *,
    effective_uid: int,
    ports: ContainerCheckPorts = DEFAULT_CHECK_PORTS,
) -> None:
    """Verify the non-root, offline, fixed-dependency runtime boundary."""
    if effective_uid == 0:
        msg = "worker image must not run as root"
        raise RuntimeError(msg)
    for flag in OFFLINE_FLAGS:
        if environment.get(flag) != "1":
            msg = "worker image offline flags are incomplete"
            raise RuntimeError(msg)
    if environment.get("MODEL_PATH") != DEFAULT_MODEL_PATH:
        msg = "worker image model path is not fixed"
        raise RuntimeError(msg)

    ports.bundle_verifier(Path(DEFAULT_MODEL_PATH))
    for distribution, expected_version in EXPECTED_PACKAGES.items():
        if ports.version_lookup(distribution) != expected_version:
            msg = "worker image dependency version does not match"
            raise RuntimeError(msg)
    for module_name in EXPECTED_MODULES:
        ports.module_importer(module_name)
    if FFPROBE_VERSION_MARKER not in ports.probe_version():
        msg = "worker image ffprobe version does not match"
        raise RuntimeError(msg)


def main() -> None:
    """Run the safe image check without starting the RunPod network loop."""
    check_container_runtime(os.environ, effective_uid=os.geteuid())
    sys.stdout.write("container-check:ok\n")


if __name__ == "__main__":
    main()
