"""Tests for the RunPod worker package."""

from scribe_drop_worker import SCHEMA_VERSION


def test_schema_version_starts_at_one() -> None:
    """The cross-system contract starts at version one."""
    assert SCHEMA_VERSION == 1
