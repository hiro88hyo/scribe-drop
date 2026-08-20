"""Pinned production HTTP adapters for the Cloud Run one-shot runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, TypeVar
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ValidationError

from .cloud_run_contracts import (
    AckRequest,
    AckResponse,
    BootstrapRequest,
    BootstrapResponse,
    ClaimRequest,
    ClaimResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    TerminalRequest,
    TerminalResponse,
)
from .cloud_run_errors import (
    BOOTSTRAP_REJECTED,
    SESSION_REJECTED,
    OneShotRuntimeError,
    UnknownControlOutcomeError,
)
from .http_client import (
    CONNECT_TIMEOUT_SECONDS,
    MAX_CONTROL_RESPONSE_BYTES,
    READ_TIMEOUT_SECONDS,
    URL_PURPOSE_EXTENSION,
    WRITE_TIMEOUT_SECONDS,
    CapabilityHttpClient,
    PinnedDnsTransport,
)
from .url_policy import UrlPolicy, UrlPurpose

if TYPE_CHECKING:
    from .http_client import TransportFactory
    from .one_shot import OneShotEnvironment

METADATA_IDENTITY_URL: Final = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
MAX_IDENTITY_TOKEN_BYTES: Final = 8_192
HTTP_OK: Final = 200
MIN_IDENTITY_TOKEN_BYTES: Final = 100
JWT_SEPARATOR_COUNT: Final = 2
TModel = TypeVar("TModel", bound=BaseModel)


def _read_limited(response: httpx.Response, limit: int) -> bytes:
    body = bytearray()
    for chunk in response.iter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            msg = "response exceeded fixed limit"
            raise ValueError(msg)
    return bytes(body)


class MetadataIdentityClient:
    """Fetch only a full Google identity token from the fixed metadata endpoint."""

    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        """Create a no-proxy, no-redirect metadata client."""
        self._client = httpx.Client(
            follow_redirects=False,
            timeout=httpx.Timeout(5.0),
            transport=transport,
            trust_env=False,
        )

    def token(self, audience: str) -> str:
        """Request one audience-bound token without retaining it after bootstrap."""
        try:
            with self._client.stream(
                "GET",
                METADATA_IDENTITY_URL,
                headers={"metadata-flavor": "Google"},
                params={"audience": audience, "format": "full"},
            ) as response:
                token = _validate_metadata_response(response)
        except (httpx.HTTPError, UnicodeError, ValueError):
            raise OneShotRuntimeError(BOOTSTRAP_REJECTED) from None
        else:
            return token

    def close(self) -> None:
        """Close the metadata connection pool."""
        self._client.close()


class CloudRunRuntimeControlClient:
    """Post strict control models to fixed paths over DNS-pinned HTTPS."""

    def __init__(
        self,
        policy: UrlPolicy,
        *,
        metadata: MetadataIdentityClient,
        capability: CapabilityHttpClient,
        transport_factory: TransportFactory | None = None,
    ) -> None:
        """Create a pinned client and bind closure of all shared network pools."""
        transport = (
            PinnedDnsTransport(policy)
            if transport_factory is None
            else PinnedDnsTransport(policy, transport_factory=transport_factory)
        )
        self._client = httpx.Client(
            follow_redirects=False,
            timeout=httpx.Timeout(
                connect=CONNECT_TIMEOUT_SECONDS,
                read=READ_TIMEOUT_SECONDS,
                write=WRITE_TIMEOUT_SECONDS,
                pool=CONNECT_TIMEOUT_SECONDS,
            ),
            transport=transport,
            trust_env=False,
        )
        self._metadata = metadata
        self._capability = capability
        self._closed = False

    def bootstrap(self, origin: str, request: BootstrapRequest) -> BootstrapResponse:
        """Post an identity bootstrap request."""
        return self._post(origin, "/internal/cloud-run/bootstrap", request, BootstrapResponse)

    def claim(self, origin: str, request: ClaimRequest) -> ClaimResponse:
        """Post a signed challenge claim."""
        return self._post(origin, "/internal/cloud-run/claim", request, ClaimResponse)

    def acknowledge(self, origin: str, request: AckRequest) -> None:
        """Persist acknowledgement before application effects."""
        self._post(origin, "/internal/cloud-run/ack", request, AckResponse)

    def heartbeat(self, origin: str, request: HeartbeatRequest) -> HeartbeatResponse:
        """Persist one monotonic liveness event."""
        return self._post(origin, "/internal/cloud-run/heartbeat", request, HeartbeatResponse)

    def terminal(self, origin: str, request: TerminalRequest) -> TerminalResponse:
        """Persist and revoke one terminal session event."""
        return self._post(origin, "/internal/cloud-run/terminal", request, TerminalResponse)

    def close(self) -> None:
        """Close every network pool once."""
        if self._closed:
            return
        self._client.close()
        self._metadata.close()
        self._capability.close()
        self._closed = True

    def _post(
        self,
        origin: str,
        path: str,
        request: BaseModel,
        response_model: type[TModel],
    ) -> TModel:
        parsed = urlsplit(origin)
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise OneShotRuntimeError(SESSION_REJECTED)
        url = f"{origin}{path}"
        try:
            with self._client.stream(
                "POST",
                url,
                json=request.model_dump(mode="json", by_alias=True),
                extensions={URL_PURPOSE_EXTENSION: UrlPurpose.ORCHESTRATOR.value},
            ) as response:
                body = _validate_control_response(response)
            return response_model.model_validate_json(body)
        except OneShotRuntimeError:
            raise
        except httpx.TransportError:
            raise UnknownControlOutcomeError from None
        except (ValidationError, ValueError):
            raise OneShotRuntimeError(SESSION_REJECTED) from None


def _validate_metadata_response(response: httpx.Response) -> str:
    """Validate metadata provenance and bounded JWT syntax."""
    if response.status_code != HTTP_OK or response.headers.get("metadata-flavor") != "Google":
        msg = "metadata identity response rejected"
        raise ValueError(msg)
    token = _read_limited(response, MAX_IDENTITY_TOKEN_BYTES).decode("ascii")
    if (
        len(token) < MIN_IDENTITY_TOKEN_BYTES
        or token.count(".") != JWT_SEPARATOR_COUNT
        or any(character.isspace() for character in token)
    ):
        msg = "metadata identity token rejected"
        raise ValueError(msg)
    return token


def _validate_control_response(response: httpx.Response) -> bytes:
    """Require a bounded successful JSON response."""
    if response.status_code != HTTP_OK or not response.headers.get(
        "content-type", ""
    ).lower().startswith("application/json"):
        raise OneShotRuntimeError(SESSION_REJECTED)
    return _read_limited(response, MAX_CONTROL_RESPONSE_BYTES)


@dataclass(frozen=True, slots=True)
class OneShotNetworkDependencies:
    """Concrete adapters sharing fixed URL policy and connection pools."""

    control: CloudRunRuntimeControlClient
    identity: MetadataIdentityClient
    source: CapabilityHttpClient
    upload: CapabilityHttpClient


def create_one_shot_network_dependencies(
    settings: OneShotEnvironment,
) -> OneShotNetworkDependencies:
    """Create no-proxy, no-redirect, independently allowlisted clients."""
    orchestrator_host = urlsplit(settings.orchestrator_origin).hostname
    if orchestrator_host is None:
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED)
    policy = UrlPolicy(
        orchestrator_host=orchestrator_host,
        source_hosts=frozenset({settings.source_host}),
        result_hosts=frozenset({settings.result_host}),
    )
    metadata = MetadataIdentityClient()
    capability = CapabilityHttpClient(policy)
    control = CloudRunRuntimeControlClient(
        policy,
        metadata=metadata,
        capability=capability,
    )
    return OneShotNetworkDependencies(
        control=control,
        identity=metadata,
        source=capability,
        upload=capability,
    )
