"""Build and verify the immutable faster-whisper model bundle."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Final, Protocol, Self

from huggingface_hub import snapshot_download
from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL_REPOSITORY: Final = "dropbox-dash/faster-whisper-large-v3-turbo"
MODEL_REVISION: Final = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
MODEL_METADATA_FILENAME: Final = "model-metadata.json"
SHA256_PATTERN: Final = r"^[0-9a-f]{64}$"
GIT_SHA_PATTERN: Final = r"^[0-9a-f]{40}$"
HASH_CHUNK_BYTES: Final = 1024 * 1024


class ModelFileSpec(BaseModel):
    """Expected immutable file metadata."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    size: int = Field(gt=0)
    sha256: str = Field(pattern=SHA256_PATTERN)


MODEL_FILE_SPECS: Final[dict[str, ModelFileSpec]] = {
    "config.json": ModelFileSpec(
        size=2_263,
        sha256="b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e",
    ),
    "model.bin": ModelFileSpec(
        size=1_617_884_929,
        sha256="e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
    ),
    "preprocessor_config.json": ModelFileSpec(
        size=340,
        sha256="7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
    ),
    "tokenizer.json": ModelFileSpec(
        size=2_710_337,
        sha256="297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
    ),
    "vocabulary.json": ModelFileSpec(
        size=1_068_114,
        sha256="c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
    ),
}


class ModelBundleMetadata(BaseModel):
    """Machine-verifiable provenance stored next to the model."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    repository: str
    revision: str = Field(pattern=GIT_SHA_PATTERN)
    files: dict[str, ModelFileSpec]

    @model_validator(mode="after")
    def validate_fixed_provenance(self) -> Self:
        """Reject metadata that does not describe the reviewed model."""
        if (
            self.repository != MODEL_REPOSITORY
            or self.revision != MODEL_REVISION
            or self.files != MODEL_FILE_SPECS
        ):
            msg = "model metadata does not match the fixed bundle"
            raise ValueError(msg)
        return self


class SnapshotDownloader(Protocol):
    """Subset of Hugging Face Hub used only during image construction."""

    def __call__(
        self,
        repo_id: str,
        *,
        revision: str,
        local_dir: Path,
        allow_patterns: list[str],
    ) -> object:
        """Download a revision-limited set of files."""


DigestFile = Callable[[Path], str]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_model_files(directory: Path, *, digest_file: DigestFile) -> None:
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        msg = "model bundle must be an absolute non-symlink directory"
        raise ValueError(msg)

    expected_names = set(MODEL_FILE_SPECS)
    allowed_names = expected_names | {MODEL_METADATA_FILENAME}
    actual_names = {entry.name for entry in directory.iterdir()}
    if not expected_names.issubset(actual_names) or not actual_names.issubset(allowed_names):
        msg = "model bundle contains missing or unexpected entries"
        raise ValueError(msg)

    for filename, spec in MODEL_FILE_SPECS.items():
        model_file = directory / filename
        if model_file.is_symlink() or not model_file.is_file():
            msg = "model bundle entries must be regular files"
            raise ValueError(msg)
        if model_file.stat().st_size != spec.size:
            msg = "model bundle file size does not match"
            raise ValueError(msg)
        if digest_file(model_file) != spec.sha256:
            msg = "model bundle file digest does not match"
            raise ValueError(msg)


def seal_model_bundle(
    directory: Path,
    *,
    digest_file: DigestFile = _sha256_file,
) -> ModelBundleMetadata:
    """Verify downloaded files and add deterministic provenance metadata."""
    _verify_model_files(directory, digest_file=digest_file)
    metadata = ModelBundleMetadata(
        repository=MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        files=MODEL_FILE_SPECS,
    )
    metadata_path = directory / MODEL_METADATA_FILENAME
    metadata_path.write_text(
        json.dumps(
            metadata.model_dump(mode="json"),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return metadata


def verify_model_bundle(
    directory: Path,
    *,
    digest_file: DigestFile = _sha256_file,
) -> ModelBundleMetadata:
    """Verify every model file and its fixed provenance metadata."""
    _verify_model_files(directory, digest_file=digest_file)
    metadata_path = directory / MODEL_METADATA_FILENAME
    if metadata_path.is_symlink() or not metadata_path.is_file():
        msg = "model bundle metadata is missing"
        raise ValueError(msg)
    try:
        raw_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        msg = "model bundle metadata is invalid"
        raise ValueError(msg) from None
    return ModelBundleMetadata.model_validate(raw_metadata)


def download_model_bundle(
    destination: Path,
    *,
    downloader: SnapshotDownloader = snapshot_download,
    digest_file: DigestFile = _sha256_file,
) -> ModelBundleMetadata:
    """Download one fixed public revision and seal it for offline use."""
    if not destination.is_absolute() or destination.exists():
        msg = "model destination must be an absent absolute path"
        raise ValueError(msg)
    downloader(
        MODEL_REPOSITORY,
        revision=MODEL_REVISION,
        local_dir=destination,
        allow_patterns=sorted(MODEL_FILE_SPECS),
    )
    cache_directory = destination / ".cache"
    if cache_directory.exists():
        shutil.rmtree(cache_directory)
    return seal_model_bundle(destination, digest_file=digest_file)


def main(arguments: list[str] | None = None) -> None:
    """Download the fixed model bundle during the container build."""
    values = sys.argv[1:] if arguments is None else arguments
    if len(values) != 1:
        msg = "usage: python -m scribe_drop_worker.model_bundle ABSOLUTE_DESTINATION"
        raise SystemExit(msg)
    download_model_bundle(Path(values[0]))


if __name__ == "__main__":
    main()
