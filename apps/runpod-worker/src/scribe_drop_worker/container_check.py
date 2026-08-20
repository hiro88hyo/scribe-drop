"""Offline integrity and runtime checks for the built worker image."""

from __future__ import annotations

import importlib
import importlib.metadata
import os
import subprocess
import sys
import tempfile
import wave
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .constants import DEFAULT_MODEL_PATH
from .media import FfprobeMediaProbe, MediaInfo
from .model_bundle import ModelBundleMetadata, verify_model_bundle

EXPECTED_PACKAGES: Final[dict[str, str]] = {
    "ctranslate2": "4.8.1",
    "faster-whisper": "1.2.1",
    "huggingface-hub": "1.24.0",
    "httpx": "0.28.1",
    "numpy": "2.5.1",
    "pydantic": "2.13.4",
    "runpod": "1.11.0",
}
EXPECTED_MODULES: Final = (
    "ctranslate2",
    "faster_whisper",
    "httpx",
    "numpy",
    "pydantic",
    "runpod",
    "scribe_drop_worker.bounded_container_check",
    "scribe_drop_worker.cloud_run_bounded_gpu_benchmark",
)
OFFLINE_FLAGS: Final = (
    "HF_DATASETS_OFFLINE",
    "HF_HUB_OFFLINE",
    "TRANSFORMERS_OFFLINE",
)
FFPROBE_VERSION_MARKER: Final = "ffprobe version 6.1.1"
SYNTHETIC_DURATION_MIN_SECONDS: Final = 0.99
SYNTHETIC_DURATION_MAX_SECONDS: Final = 1.01

VersionLookup = Callable[[str], str]
ModuleImporter = Callable[[str], object]
BundleVerifier = Callable[[Path], ModelBundleMetadata]
ProbeVersion = Callable[[], str]
ProbeMedia = Callable[[], MediaInfo]


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


def _probe_synthetic_media() -> MediaInfo:
    with tempfile.TemporaryDirectory(
        prefix="scribe-drop-container-check-",
        dir="/tmp",
    ) as task_directory:
        source = Path(task_directory) / "silence.wav"
        with wave.open(str(source), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16_000)
            output.writeframes(bytes(32_000))
        return FfprobeMediaProbe().probe(source, max_duration_seconds=2)


@dataclass(frozen=True)
class ContainerCheckPorts:
    """Replaceable read-only boundaries used by the image check."""

    version_lookup: VersionLookup = importlib.metadata.version
    module_importer: ModuleImporter = importlib.import_module
    bundle_verifier: BundleVerifier = verify_model_bundle
    probe_version: ProbeVersion = _read_ffprobe_version
    probe_media: ProbeMedia = _probe_synthetic_media


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
    media = ports.probe_media()
    if (
        media.audio_codec != "pcm_s16le"
        or media.audio_stream_index != 0
        or media.format_name != "wav"
        or media.stream_count != 1
        or not SYNTHETIC_DURATION_MIN_SECONDS
        <= media.duration_seconds
        <= SYNTHETIC_DURATION_MAX_SECONDS
    ):
        msg = "worker image media probe does not match"
        raise RuntimeError(msg)


def main() -> None:
    """Run the safe image check without starting the RunPod network loop."""
    check_container_runtime(os.environ, effective_uid=os.geteuid())
    sys.stdout.write("container-check:ok\n")


if __name__ == "__main__":
    main()
