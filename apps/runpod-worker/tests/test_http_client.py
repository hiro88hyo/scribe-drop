"""Tests for DNS-pinned capability HTTP operations."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import httpx
import pytest

from scribe_drop_worker.contracts import (
    RunpodClaimDeduplicated,
    RunpodClaimGranted,
    RunpodClaimRequest,
    RunpodHeartbeatRequest,
)
from scribe_drop_worker.errors import WorkerError
from scribe_drop_worker.http_client import (
    CapabilityHttpClient,
    PinnedDnsTransport,
    SourceDownloadExpectation,
)
from scribe_drop_worker.url_policy import UrlPolicy

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

JOB_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
ATTEMPT_ID: Final = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
TOKEN: Final = "A" * 43
PUBLIC_IP: Final = "8.8.8.8"
SOURCE_CONTENT: Final = b"abcdef"
EXPECTED_CHUNKS: Final = 2
OWNER_HASH: Final = "a" * 32
RESULT_PREFIX: Final = f"results/{OWNER_HASH}/{JOB_ID}/{ATTEMPT_ID}/"


class RecordingTransport(httpx.BaseTransport):
    """Deterministic transport that records the pinned request."""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]) -> None:
        """Configure a response factory."""
        self.responder = responder
        self.requests: list[httpx.Request] = []
        self.closed = False

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Record and answer one request."""
        self.requests.append(request)
        return self.responder(request)

    def close(self) -> None:
        """Record connection pool cleanup."""
        self.closed = True


def build_client(
    responder: Callable[[httpx.Request], httpx.Response],
) -> tuple[CapabilityHttpClient, RecordingTransport]:
    """Create a client with deterministic public DNS and transport."""
    transport = RecordingTransport(responder)
    policy = UrlPolicy(
        orchestrator_host="hooks.example.invalid",
        source_hosts=frozenset({"storage.example.invalid"}),
        result_hosts=frozenset({"storage.example.invalid"}),
        resolver=lambda _host, _port: (PUBLIC_IP,),
    )
    return (
        CapabilityHttpClient(
            policy,
            transport_factory=lambda _hostname, _address: transport,
        ),
        transport,
    )


def claim_request() -> RunpodClaimRequest:
    """Return a valid one-time claim request."""
    return RunpodClaimRequest.model_validate(
        {
            "jobId": JOB_ID,
            "attemptId": ATTEMPT_ID,
            "runpodJobId": "runpod-job",
            "claimToken": TOKEN,
        }
    )


def heartbeat_request() -> RunpodHeartbeatRequest:
    """Return a valid heartbeat request."""
    return RunpodHeartbeatRequest.model_validate(
        {
            "jobId": JOB_ID,
            "attemptId": ATTEMPT_ID,
            "runpodJobId": "runpod-job",
            "heartbeatToken": TOKEN,
        }
    )


def granted_claim() -> RunpodClaimGranted:
    """Return path-style R2 capabilities from the Orchestrator."""
    storage = "https://storage.example.invalid/bucket/"
    return RunpodClaimGranted.model_validate(
        {
            "granted": True,
            "source": {
                "getUrl": (
                    f"{storage}incoming/{OWNER_HASH}/{JOB_ID}/{'b' * 22}/"
                    "source.mp3?X-Amz-Signature=redacted"
                ),
                "expectedSizeBytes": len(SOURCE_CONTENT),
                "expectedEtag": "expected",
            },
            "results": {
                "markdownPutUrl": (
                    f"{storage}{RESULT_PREFIX}transcript.md?X-Amz-Signature=redacted"
                ),
                "jsonPutUrl": (f"{storage}{RESULT_PREFIX}transcript.json?X-Amz-Signature=redacted"),
                "srtPutUrl": (f"{storage}{RESULT_PREFIX}transcript.srt?X-Amz-Signature=redacted"),
                "manifestPutUrl": (
                    f"{storage}{RESULT_PREFIX}manifest.json?X-Amz-Signature=redacted"
                ),
            },
            "heartbeat": {
                "url": "https://hooks.example.invalid/internal/runpod/heartbeat",
                "token": TOKEN,
            },
            "expiresAt": "2026-07-25T02:00:00.000Z",
        }
    )


def test_claim_pins_validated_ip_and_preserves_host_and_sni() -> None:
    """The socket target cannot change after DNS validation."""

    def responder(request: httpx.Request) -> httpx.Response:
        assert request.url.host == PUBLIC_IP
        assert request.headers["host"] == "hooks.example.invalid"
        assert request.extensions["sni_hostname"] == "hooks.example.invalid"
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"deduplicated": True},
        )

    client, transport = build_client(responder)
    result = client.claim(
        "https://hooks.example.invalid/internal/runpod/claim",
        claim_request(),
    )
    client.close()

    assert isinstance(result, RunpodClaimDeduplicated)
    assert len(transport.requests) == 1
    assert transport.closed is True


def test_all_claim_capability_paths_are_validated_before_use() -> None:
    """Source, results, and heartbeat stay bound to this job and attempt."""
    client, transport = build_client(lambda _request: httpx.Response(500))
    paths = client.validate_claim_capabilities(
        granted_claim(),
        job_id=JOB_ID,
        attempt_id=ATTEMPT_ID,
    )
    assert paths.result_keys.json_artifact == f"{RESULT_PREFIX}transcript.json"
    assert paths.manifest_key == f"{RESULT_PREFIX}manifest.json"
    assert transport.requests == []
    client.close()


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        (
            "source",
            "https://storage.example.invalid/bucket/incoming/wrong/source.mp3"
            "?X-Amz-Signature=redacted",
        ),
        (
            "heartbeat",
            "https://hooks.example.invalid/internal/runpod/other",
        ),
        (
            "json",
            f"https://storage.example.invalid/bucket/results/{OWNER_HASH}/{JOB_ID}/{JOB_ID}/"
            "transcript.json?X-Amz-Signature=redacted",
        ),
    ],
)
def test_claim_capability_path_mismatch_fails_before_network(
    field: str,
    replacement: str,
) -> None:
    """A trusted response still cannot widen object or endpoint scope."""
    claim = granted_claim()
    if field == "source":
        claim = claim.model_copy(
            update={"source": claim.source.model_copy(update={"get_url": replacement})}
        )
    elif field == "heartbeat":
        claim = claim.model_copy(
            update={"heartbeat": claim.heartbeat.model_copy(update={"url": replacement})}
        )
    else:
        claim = claim.model_copy(
            update={
                "results": claim.results.model_copy(update={"json_put_url": replacement}),
            }
        )
    client, transport = build_client(lambda _request: httpx.Response(500))
    with pytest.raises((ValueError, WorkerError)):
        client.validate_claim_capabilities(
            claim,
            job_id=JOB_ID,
            attempt_id=ATTEMPT_ID,
        )
    assert transport.requests == []
    client.close()


@pytest.mark.parametrize(
    ("status", "headers", "body"),
    [
        (302, {"location": "https://other.example.invalid"}, b""),
        (200, {"content-type": "text/plain"}, b"not json"),
        (
            200,
            {"content-type": "application/json"},
            b'{"deduplicated":true,"unexpected":true}',
        ),
    ],
)
def test_claim_fails_closed_for_redirects_and_invalid_responses(
    status: int,
    headers: dict[str, str],
    body: bytes,
) -> None:
    """Redirects and malformed control responses never issue capabilities."""
    client, _transport = build_client(
        lambda _request: httpx.Response(status, headers=headers, content=body)
    )
    with pytest.raises(WorkerError) as failure:
        client.claim(
            "https://hooks.example.invalid/internal/runpod/claim",
            claim_request(),
        )
    assert failure.value.code == "CLAIM_REJECTED"
    client.close()


def test_heartbeat_parses_only_the_strict_cancel_response() -> None:
    """Heartbeat accepts one boolean cancellation field."""
    client, _transport = build_client(
        lambda _request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"cancelRequested": False},
        )
    )
    response = client.heartbeat(
        "https://hooks.example.invalid/internal/runpod/heartbeat",
        heartbeat_request(),
    )
    assert response.cancel_requested is False
    client.close()


def test_download_streams_exact_source_and_checks_etag(tmp_path: Path) -> None:
    """The source is written once and its expected length and ETag are enforced."""
    client, _transport = build_client(
        lambda _request: httpx.Response(
            200,
            headers={
                "content-length": "6",
                "etag": '"expected-etag"',
            },
            content=[b"abc", b"def"],
        )
    )
    destination = tmp_path / "source.bin"
    chunks = 0

    def on_chunk() -> None:
        nonlocal chunks
        chunks += 1

    received = client.download(
        "https://storage.example.invalid/bucket/source?X-Amz-Signature=redacted",
        destination,
        expectation=SourceDownloadExpectation(
            size_bytes=len(SOURCE_CONTENT),
            etag="expected-etag",
            max_size_bytes=10,
        ),
        on_chunk=on_chunk,
    )
    assert received == len(SOURCE_CONTENT)
    assert destination.read_bytes() == SOURCE_CONTENT
    assert chunks == EXPECTED_CHUNKS
    client.close()


@pytest.mark.parametrize(
    ("headers", "content", "code"),
    [
        ({"content-length": "7", "etag": "expected"}, b"abcdef", "SOURCE_SIZE_MISMATCH"),
        ({"content-length": "6", "etag": "other"}, b"abcdef", "SOURCE_ETAG_MISMATCH"),
        ({"content-length": "6", "etag": "expected"}, b"abcdefg", "SOURCE_SIZE_MISMATCH"),
        (
            {"content-length": "6", "etag": "expected", "content-encoding": "gzip"},
            b"abcdef",
            "SOURCE_DOWNLOAD_FAILED",
        ),
    ],
)
def test_download_fails_closed_on_source_mismatch(
    tmp_path: Path,
    headers: dict[str, str],
    content: bytes,
    code: str,
) -> None:
    """Declared, streamed, encoded, and immutable source mismatches are distinct."""
    client, _transport = build_client(
        lambda _request: httpx.Response(200, headers=headers, content=content)
    )
    with pytest.raises(WorkerError) as failure:
        client.download(
            "https://storage.example.invalid/bucket/source?X-Amz-Signature=redacted",
            tmp_path / "source.bin",
            expectation=SourceDownloadExpectation(
                size_bytes=len(SOURCE_CONTENT),
                etag="expected",
                max_size_bytes=len(SOURCE_CONTENT),
            ),
        )
    assert failure.value.code == code
    client.close()


def test_artifact_and_manifest_put_use_separate_error_codes() -> None:
    """A failed completion marker is distinguishable from a failed artifact."""
    client, transport = build_client(lambda _request: httpx.Response(503))
    with pytest.raises(WorkerError) as artifact:
        client.put_artifact(
            "https://storage.example.invalid/bucket/transcript.json?X-Amz-Signature=redacted",
            b"{}",
            "application/json",
        )
    with pytest.raises(WorkerError) as manifest:
        client.put_manifest(
            "https://storage.example.invalid/bucket/manifest.json?X-Amz-Signature=redacted",
            b"{}",
        )
    assert artifact.value.code == "ARTIFACT_UPLOAD_FAILED"
    assert manifest.value.code == "MANIFEST_UPLOAD_FAILED"
    assert [request.method for request in transport.requests] == ["PUT", "PUT"]
    client.close()


def test_transport_rejects_missing_purpose_before_network() -> None:
    """Callers cannot bypass URL classification."""
    recording = RecordingTransport(lambda _request: httpx.Response(200))
    policy = UrlPolicy(
        orchestrator_host="hooks.example.invalid",
        source_hosts=frozenset({"storage.example.invalid"}),
        result_hosts=frozenset({"storage.example.invalid"}),
        resolver=lambda _host, _port: (PUBLIC_IP,),
    )
    transport = PinnedDnsTransport(
        policy,
        transport_factory=lambda _hostname, _address: recording,
    )
    with pytest.raises(httpx.InvalidURL):
        transport.handle_request(
            httpx.Request("GET", "https://hooks.example.invalid/internal/runpod/claim")
        )
    assert recording.requests == []
    transport.close()
