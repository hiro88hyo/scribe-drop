"""Tests for the built-image maximum-duration bounded core check."""

from __future__ import annotations

from typing import TYPE_CHECKING

from scribe_drop_worker.bounded_container_check import (
    BOUNDED_CONTAINER_CHECK_OK,
    check_bounded_container_core,
    main,
)

if TYPE_CHECKING:
    from pathlib import Path

    import pytest


def test_bounded_container_core_exercises_maximum_duration_and_cleans(tmp_path: Path) -> None:
    """The real production constants complete without retaining task-local files."""
    check_bounded_container_core(temporary_root=tmp_path)
    assert tuple(tmp_path.iterdir()) == ()


def test_bounded_container_main_emits_only_safe_marker(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The image gate's success output contains no execution or content values."""
    monkeypatch.setattr(
        "scribe_drop_worker.bounded_container_check.check_bounded_container_core",
        lambda: None,
    )
    main()
    captured = capsys.readouterr()
    assert captured.out == BOUNDED_CONTAINER_CHECK_OK
    assert captured.err == ""
