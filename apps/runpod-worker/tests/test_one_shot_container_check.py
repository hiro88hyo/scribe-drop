"""Tests for the Cloud Run one-shot image gate boundary."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

import scribe_drop_worker.one_shot_container_check as container_check


@dataclass(frozen=True)
class _KeyPair:
    public_key: str = "p" * 43

    def sign(self, _message: bytes) -> str:
        return "s" * 86


def test_image_gate_checks_non_root_identity_key_gpu_and_bounded_core(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The process gate composes every offline invariant and emits one marker."""
    calls: list[str] = []
    monkeypatch.setattr(container_check, "_effective_uid", lambda: 10001)
    monkeypatch.setattr(container_check, "_model_present", lambda: True)
    monkeypatch.setattr(
        container_check,
        "load_one_shot_environment",
        lambda _environment: calls.append("environment"),
    )
    monkeypatch.setattr(
        container_check,
        "require_exact_cuda_device",
        lambda counter: calls.append(f"gpu:{counter()}"),
    )
    monkeypatch.setattr(container_check, "create_runtime_key_pair", _KeyPair)
    monkeypatch.setattr(
        container_check,
        "check_bounded_container_core",
        lambda: calls.append("bounded"),
    )

    container_check.main()

    assert calls == ["environment", "gpu:1", "bounded"]
    assert capsys.readouterr().out == "cloud-run-one-shot-container-check:ok\n"


def test_image_gate_rejects_root_or_missing_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Image identity drift fails before the bounded core."""
    monkeypatch.setattr(container_check, "_effective_uid", lambda: 0)
    with pytest.raises(RuntimeError, match="identity invariant"):
        container_check.main()
