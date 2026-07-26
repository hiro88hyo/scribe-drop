"""Exact-host HTTPS validation and DNS address policy."""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, cast
from urllib.parse import SplitResult, urlsplit

from .constants import MAX_URL_LENGTH

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    AddressResolver = Callable[[str, int], Iterable[str]]


class UrlPurpose(StrEnum):
    """Capability classes with independent host allowlists."""

    ORCHESTRATOR = "orchestrator"
    SOURCE = "source"
    RESULT = "result"


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    """Validated URL plus the addresses observed during policy evaluation."""

    value: str
    parsed: SplitResult
    addresses: tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]

    @property
    def hostname(self) -> str:
        """Return the canonical DNS hostname."""
        hostname = self.parsed.hostname
        if hostname is None:  # pragma: no cover - guarded by validation
            raise AssertionError
        return hostname


def resolve_addresses(hostname: str, port: int) -> tuple[str, ...]:
    """Resolve all TCP addresses without performing an HTTP request."""
    records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    return tuple(dict.fromkeys(cast("str", record[4][0]) for record in records))


class UrlPolicy:
    """Validate capability URLs against exact hosts and public DNS answers."""

    def __init__(
        self,
        *,
        orchestrator_host: str,
        source_hosts: frozenset[str],
        result_hosts: frozenset[str],
        resolver: AddressResolver = resolve_addresses,
    ) -> None:
        """Configure independent exact-host allowlists and a resolver."""
        self._allowed_hosts = {
            UrlPurpose.ORCHESTRATOR: frozenset({orchestrator_host}),
            UrlPurpose.SOURCE: source_hosts,
            UrlPurpose.RESULT: result_hosts,
        }
        self._resolver = resolver

    def validate(self, value: str, purpose: UrlPurpose) -> ValidatedUrl:
        """Reject unsafe syntax, unexpected hosts, and non-public DNS answers."""
        parsed, canonical_host = self._validate_syntax(value, purpose)
        addresses = self._resolve_public_addresses(canonical_host)
        return ValidatedUrl(value=value, parsed=parsed, addresses=addresses)

    def _validate_syntax(self, value: str, purpose: UrlPurpose) -> tuple[SplitResult, str]:
        if len(value) > MAX_URL_LENGTH:
            msg = "URL is too long"
            raise ValueError(msg)
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError as error:
            msg = "URL port is invalid"
            raise ValueError(msg) from error
        hostname = parsed.hostname
        if (
            parsed.scheme != "https"
            or hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
            or parsed.fragment != ""
        ):
            msg = "URL must be credential-free HTTPS on port 443"
            raise ValueError(msg)
        canonical_host = hostname.rstrip(".").lower().encode("idna").decode("ascii")
        try:
            ipaddress.ip_address(canonical_host)
        except ValueError:
            pass
        else:
            msg = "IP literals are not allowed"
            raise ValueError(msg)
        if canonical_host not in self._allowed_hosts[purpose]:
            msg = "URL host is not allowlisted"
            raise ValueError(msg)
        if purpose is UrlPurpose.ORCHESTRATOR and parsed.query != "":
            msg = "Orchestrator URL must not contain a query"
            raise ValueError(msg)
        return parsed, canonical_host

    def _resolve_public_addresses(
        self, canonical_host: str
    ) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
        try:
            raw_addresses = tuple(self._resolver(canonical_host, 443))
        except OSError as error:
            msg = "URL host could not be resolved"
            raise ValueError(msg) from error
        if not raw_addresses:
            msg = "URL host did not resolve"
            raise ValueError(msg)
        try:
            addresses = tuple(ipaddress.ip_address(value) for value in raw_addresses)
        except ValueError as error:
            msg = "URL host resolved to an invalid address"
            raise ValueError(msg) from error
        if any(not _is_public_address(address) for address in addresses):
            msg = "URL host resolved to a non-public address"
            raise ValueError(msg)
        return tuple(dict.fromkeys(addresses))


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        address.is_global
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_private
        and not address.is_reserved
        and not address.is_unspecified
    )
