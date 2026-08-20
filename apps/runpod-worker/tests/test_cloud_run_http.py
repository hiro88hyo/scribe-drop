"""Tests for pinned Cloud Run metadata and runtime control HTTP adapters."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Final

import httpx
import pytest

from scribe_drop_worker.cloud_run_contracts import (
    BootstrapRequest,
    BootstrapResponse,
    HeartbeatRequest,
)
from scribe_drop_worker.cloud_run_errors import OneShotRuntimeError, UnknownControlOutcomeError
from scribe_drop_worker.cloud_run_http import (
    CloudRunRuntimeControlClient,
    MetadataIdentityClient,
)
from scribe_drop_worker.http_client import CapabilityHttpClient
from scribe_drop_worker.url_policy import UrlPolicy

if TYPE_CHECKING:
    from collections.abc import Callable

PUBLIC_IP: Final = "8.8.8.8"
HANDLE: Final = "h" * 43
TOKEN: Final = f"{'a' * 40}.{'b' * 40}.{'c' * 40}"


class RecordingTransport(httpx.BaseTransport):
    """Record requests and delegate deterministic responses."""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]) -> None:
        """Bind one response factory."""
        self.responder = responder
        self.requests: list[httpx.Request] = []
        self.closed = False

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Record and respond."""
        self.requests.append(request)
        return self.responder(request)

    def close(self) -> None:
        """Record pool closure."""
        self.closed = True


def policy() -> UrlPolicy:
    """Return a public-address fake policy."""
    return UrlPolicy(
        orchestrator_host="orchestrator.example.invalid",
        source_hosts=frozenset({"storage.example.invalid"}),
        result_hosts=frozenset({"storage.example.invalid"}),
        resolver=lambda _host, _port: (PUBLIC_IP,),
    )


def bootstrap_request() -> BootstrapRequest:
    """Return one strict dummy bootstrap."""
    return BootstrapRequest(
        bootstrapRequestId="01ARZ3NDEKTSV4RRFFQ69G5FAX",
        environment="staging",
        executionHandle=HANDLE,
        executionName="sd-stg-execution-1",
        identityToken=TOKEN,
        jobName="sd-stg-job-1",
        policyId="cloud_run_jobs_l4_v1",
        publicKey="p" * 43,
        taskAttempt=0,
        taskCount=1,
        taskIndex=0,
    )


def runtime_client(
    responder: Callable[[httpx.Request], httpx.Response],
) -> tuple[CloudRunRuntimeControlClient, RecordingTransport]:
    """Build shared fake pools around the production pinning transport."""
    selected_policy = policy()
    control_transport = RecordingTransport(responder)
    capability_transport = RecordingTransport(lambda request: httpx.Response(200, request=request))
    capability = CapabilityHttpClient(
        selected_policy,
        transport_factory=lambda _host, _address: capability_transport,
    )
    metadata = MetadataIdentityClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"metadata-flavor": "Google"},
                content=TOKEN,
                request=request,
            )
        )
    )
    return (
        CloudRunRuntimeControlClient(
            selected_policy,
            metadata=metadata,
            capability=capability,
            transport_factory=lambda _host, _address: control_transport,
        ),
        control_transport,
    )


def test_metadata_identity_uses_fixed_endpoint_headers_and_bounded_jwt() -> None:
    """The adapter cannot redirect or select a metadata resource from input."""
    observed: list[httpx.Request] = []

    def responder(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        return httpx.Response(
            200,
            headers={"metadata-flavor": "Google"},
            content=TOKEN,
            request=request,
        )

    client = MetadataIdentityClient(transport=httpx.MockTransport(responder))
    result = client.token("https://orchestrator.example.invalid/internal/cloud-run/bootstrap")
    client.close()

    assert result == TOKEN
    assert observed[0].url.host == "metadata.google.internal"
    assert observed[0].headers["metadata-flavor"] == "Google"
    assert observed[0].url.params["format"] == "full"


@pytest.mark.parametrize(
    ("headers", "content"),
    [
        ({}, TOKEN),
        ({"metadata-flavor": "Google"}, "short"),
    ],
)
def test_metadata_identity_rejects_missing_provenance_or_malformed_token(
    headers: dict[str, str],
    content: str,
) -> None:
    """Metadata failures normalize before bootstrap."""
    client = MetadataIdentityClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, headers=headers, content=content, request=request)
        )
    )
    with pytest.raises(OneShotRuntimeError) as failure:
        client.token("https://orchestrator.example.invalid/internal/cloud-run/bootstrap")
    assert failure.value.code == "BOOTSTRAP_REJECTED"


def test_control_posts_alias_json_to_exact_pinned_path_and_parses_strict_response() -> None:
    """Control requests preserve the host/SNI while connecting to the validated address."""

    def responder(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.read())
        assert payload["bootstrapRequestId"] == "01ARZ3NDEKTSV4RRFFQ69G5FAX"
        assert request.url.host == PUBLIC_IP
        assert request.headers["host"] == "orchestrator.example.invalid"
        assert request.extensions["sni_hostname"] == "orchestrator.example.invalid"
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "challenge": "c" * 43,
                "challengeId": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
                "expiresAt": "2026-08-11T00:05:00.000Z",
            },
            request=request,
        )

    client, transport = runtime_client(responder)
    result = client.bootstrap(
        "https://orchestrator.example.invalid",
        bootstrap_request(),
    )
    client.close()

    assert isinstance(result, BootstrapResponse)
    assert transport.requests[0].url.path == "/internal/cloud-run/bootstrap"
    assert transport.closed is True


def test_control_distinguishes_response_loss_from_known_rejection() -> None:
    """Transport uncertainty is retryable with the exact request; HTTP rejection is not."""
    lost, _ = runtime_client(
        lambda request: (_ for _ in ()).throw(httpx.ReadError("lost", request=request))
    )
    with pytest.raises(UnknownControlOutcomeError):
        lost.bootstrap("https://orchestrator.example.invalid", bootstrap_request())

    rejected, _ = runtime_client(lambda request: httpx.Response(403, request=request))
    with pytest.raises(OneShotRuntimeError) as failure:
        rejected.heartbeat(
            "https://orchestrator.example.invalid",
            HeartbeatRequest(
                executionHandle=HANDLE,
                progress="download",
                sequence=1,
                sessionId="01ARZ3NDEKTSV4RRFFQ69G5FAZ",
                sessionToken="t" * 43,
            ),
        )
    assert failure.value.code == "SESSION_REJECTED"
