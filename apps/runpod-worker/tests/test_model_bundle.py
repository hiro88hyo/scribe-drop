"""Tests for fixed model download and integrity verification."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scribe_drop_worker.model_bundle import (
    MODEL_FILE_SPECS,
    MODEL_METADATA_FILENAME,
    MODEL_REPOSITORY,
    MODEL_REVISION,
    download_model_bundle,
    seal_model_bundle,
    verify_model_bundle,
)


def _create_sparse_model_files(directory: Path) -> None:
    directory.mkdir()
    for filename, spec in MODEL_FILE_SPECS.items():
        with (directory / filename).open("wb") as model_file:
            model_file.truncate(spec.size)


def _expected_digest(path: Path) -> str:
    return MODEL_FILE_SPECS[path.name].sha256


def test_model_bundle_is_sealed_and_verified(tmp_path: Path) -> None:
    """All reviewed files and deterministic provenance are required."""
    model_path = (tmp_path / "model").resolve()
    _create_sparse_model_files(model_path)

    sealed = seal_model_bundle(model_path, digest_file=_expected_digest)
    verified = verify_model_bundle(model_path, digest_file=_expected_digest)

    assert sealed == verified
    assert verified.repository == MODEL_REPOSITORY
    assert verified.revision == MODEL_REVISION
    metadata_text = (model_path / MODEL_METADATA_FILENAME).read_text(encoding="utf-8")
    assert metadata_text.endswith("\n")
    assert (
        json.loads(metadata_text)["files"]["model.bin"]["size"]
        == MODEL_FILE_SPECS["model.bin"].size
    )


@pytest.mark.parametrize("mutation", ["missing", "unexpected", "wrong-size", "symlink"])
def test_model_bundle_rejects_filesystem_mutation(tmp_path: Path, mutation: str) -> None:
    """Missing, extra, changed, or linked model files fail closed."""
    model_path = (tmp_path / "model").resolve()
    _create_sparse_model_files(model_path)
    if mutation == "missing":
        (model_path / "config.json").unlink()
    elif mutation == "unexpected":
        (model_path / "README.md").write_text("unexpected", encoding="utf-8")
    elif mutation == "wrong-size":
        (model_path / "config.json").write_text("{}", encoding="utf-8")
    else:
        target = model_path / "config-target.json"
        (model_path / "config.json").rename(target)
        (model_path / "config.json").symlink_to(target)

    with pytest.raises(ValueError, match="model bundle"):
        seal_model_bundle(model_path, digest_file=_expected_digest)


def test_model_bundle_rejects_digest_and_metadata_mutation(tmp_path: Path) -> None:
    """A changed payload digest or provenance record is rejected."""
    model_path = (tmp_path / "model").resolve()
    _create_sparse_model_files(model_path)
    seal_model_bundle(model_path, digest_file=_expected_digest)

    with pytest.raises(ValueError, match="digest"):
        verify_model_bundle(model_path, digest_file=lambda _path: "0" * 64)

    metadata_path = model_path / MODEL_METADATA_FILENAME
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["revision"] = "0" * 40
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    with pytest.raises(ValueError, match="fixed bundle"):
        verify_model_bundle(model_path, digest_file=_expected_digest)


def test_download_uses_only_fixed_revision_and_files(tmp_path: Path) -> None:
    """The build downloader cannot select another repository or revision."""
    destination = (tmp_path / "model").resolve()
    observed: list[tuple[str, str, list[str]]] = []

    def downloader(
        repo_id: str,
        *,
        revision: str,
        local_dir: Path,
        allow_patterns: list[str],
    ) -> object:
        observed.append((repo_id, revision, allow_patterns))
        _create_sparse_model_files(local_dir)
        cache = local_dir / ".cache"
        cache.mkdir()
        (cache / "ignored").write_text("cache", encoding="utf-8")
        return str(local_dir)

    metadata = download_model_bundle(
        destination,
        downloader=downloader,
        digest_file=_expected_digest,
    )

    assert metadata.revision == MODEL_REVISION
    assert observed == [(MODEL_REPOSITORY, MODEL_REVISION, sorted(MODEL_FILE_SPECS))]
    assert not (destination / ".cache").exists()


def test_download_requires_new_absolute_destination(tmp_path: Path) -> None:
    """Existing or relative destinations cannot be overwritten."""
    existing = (tmp_path / "existing").resolve()
    existing.mkdir()
    with pytest.raises(ValueError, match="absent absolute"):
        download_model_bundle(existing)
    with pytest.raises(ValueError, match="absent absolute"):
        download_model_bundle(Path("relative"))
