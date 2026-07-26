"""SSRF policy tests for RunPod worker capability URLs."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from scribe_drop_worker.constants import MAX_URL_LENGTH
from scribe_drop_worker.url_policy import UrlPolicy, UrlPurpose, resolve_addresses

if TYPE_CHECKING:
    from collections.abc import Iterable


def policy(addresses: Iterable[str] = ("203.0.113.10",)) -> UrlPolicy:
    """Build an exact-host policy with a deterministic resolver."""
    resolved = tuple(addresses)
    return UrlPolicy(
        orchestrator_host="hooks.example.invalid",
        source_hosts=frozenset({"source.example.invalid"}),
        result_hosts=frozenset({"result.example.invalid"}),
        resolver=lambda _host, _port: resolved,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://source.example.invalid/object",
        "https://user@source.example.invalid/object",
        "https://source.example.invalid:444/object",
        "https://127.0.0.1/object",
        "https://unlisted.example.invalid/object",
        "https://source.example.invalid/object#fragment",
    ],
)
def test_policy_rejects_unsafe_url_syntax_and_hosts(url: str) -> None:
    """HTTP, credentials, unexpected ports, IP literals, and host changes are rejected."""
    with pytest.raises(ValueError, match=r"URL|IP|allowlisted"):
        policy().validate(url, UrlPurpose.SOURCE)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
    ],
)
def test_policy_rejects_non_public_dns_answers(address: str) -> None:
    """Every DNS answer must be globally routable."""
    with pytest.raises(ValueError, match="non-public"):
        policy([address]).validate(
            "https://source.example.invalid/object?X-Amz-Signature=redacted",
            UrlPurpose.SOURCE,
        )


def test_policy_returns_validated_dns_answers_for_connection_pinning() -> None:
    """The connection layer receives exactly the addresses checked by policy."""
    validated = policy(["8.8.8.8", "2001:4860:4860::8888"]).validate(
        "https://source.example.invalid/object?X-Amz-Signature=redacted",
        UrlPurpose.SOURCE,
    )
    assert tuple(str(address) for address in validated.addresses) == (
        "8.8.8.8",
        "2001:4860:4860::8888",
    )
    assert validated.hostname == "source.example.invalid"


def test_orchestrator_url_rejects_queries() -> None:
    """Claim and heartbeat endpoints never need bearer data in query parameters."""
    with pytest.raises(ValueError, match="query"):
        policy().validate(
            "https://hooks.example.invalid/internal/runpod/claim?token=redacted",
            UrlPurpose.ORCHESTRATOR,
        )


@pytest.mark.parametrize(
    ("url", "message"),
    [
        (f"https://source.example.invalid/{'a' * MAX_URL_LENGTH}", "too long"),
        ("https://source.example.invalid:invalid/object", "port"),
    ],
)
def test_policy_rejects_oversized_and_malformed_urls(url: str, message: str) -> None:
    """Parsing errors are normalized into safe policy failures."""
    with pytest.raises(ValueError, match=message):
        policy().validate(url, UrlPurpose.SOURCE)


@pytest.mark.parametrize(
    ("resolver", "message"),
    [
        (lambda _host, _port: (), "did not resolve"),
        (lambda _host, _port: ("not-an-address",), "invalid address"),
    ],
)
def test_policy_rejects_empty_and_invalid_dns_results(resolver: object, message: str) -> None:
    """Malformed resolver results never reach the connection layer."""
    guarded = UrlPolicy(
        orchestrator_host="hooks.example.invalid",
        source_hosts=frozenset({"source.example.invalid"}),
        result_hosts=frozenset({"result.example.invalid"}),
        resolver=resolver,  # type: ignore[arg-type]  # Parametrized fake resolver.
    )
    with pytest.raises(ValueError, match=message):
        guarded.validate("https://source.example.invalid/object", UrlPurpose.SOURCE)


def test_policy_normalizes_resolver_failures() -> None:
    """DNS errors expose no resolver details."""

    def failing_resolver(_host: str, _port: int) -> tuple[str, ...]:
        detail = "sensitive resolver detail"
        raise OSError(detail)

    guarded = UrlPolicy(
        orchestrator_host="hooks.example.invalid",
        source_hosts=frozenset({"source.example.invalid"}),
        result_hosts=frozenset({"result.example.invalid"}),
        resolver=failing_resolver,
    )
    with pytest.raises(ValueError, match="could not be resolved"):
        guarded.validate("https://source.example.invalid/object", UrlPurpose.SOURCE)


def test_system_resolver_adapter_deduplicates_addresses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The resolver adapter returns only address strings once."""

    def fake_getaddrinfo(
        _host: str, _port: int, **options: int
    ) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        socket_type = options["type"]
        return [
            (2, socket_type, 6, "", ("8.8.8.8", 443)),
            (2, socket_type, 6, "", ("8.8.8.8", 443)),
        ]

    monkeypatch.setattr(
        "scribe_drop_worker.url_policy.socket.getaddrinfo",
        fake_getaddrinfo,
    )
    assert resolve_addresses("source.example.invalid", 443) == ("8.8.8.8",)
