"""DNS-pinned HTTP client for one-time RunPod capabilities."""

from __future__ import annotations

import hashlib
import os
import re
import stat
from dataclasses import dataclass
from threading import Lock
from typing import TYPE_CHECKING, Final, Literal, cast
from urllib.parse import unquote

import httpx
from pydantic import ValidationError

from .artifacts import ResultArtifactKeys, extract_result_key
from .contracts import (
    CLAIM_RESPONSE_ADAPTER,
    ClaimResponse,
    RunpodClaimGranted,
    RunpodClaimRequest,
    RunpodHeartbeatRequest,
    RunpodHeartbeatResponse,
    WorkerErrorCode,
)
from .errors import WorkerError
from .url_policy import UrlPolicy, UrlPurpose, ValidatedUrl

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable
    from pathlib import Path
    from typing import BinaryIO

    TransportFactory = Callable[[str, str], httpx.BaseTransport]

MAX_CONTROL_RESPONSE_BYTES: Final = 32 * 1024
CONNECT_TIMEOUT_SECONDS: Final = 10.0
READ_TIMEOUT_SECONDS: Final = 60.0
WRITE_TIMEOUT_SECONDS: Final = 60.0
HTTP_OK: Final = 200
HTTP_REDIRECT_START: Final = 300
ETAG_QUOTE_PAIR_LENGTH: Final = 2
URL_PURPOSE_EXTENSION: Final = "scribe_drop_url_purpose"
CLAIM_REJECTED: Final[WorkerErrorCode] = "CLAIM_REJECTED"
SOURCE_DOWNLOAD_FAILED: Final[WorkerErrorCode] = "SOURCE_DOWNLOAD_FAILED"
SOURCE_SIZE_MISMATCH: Final[WorkerErrorCode] = "SOURCE_SIZE_MISMATCH"
SOURCE_ETAG_MISMATCH: Final[WorkerErrorCode] = "SOURCE_ETAG_MISMATCH"
INTERNAL_ERROR: Final[WorkerErrorCode] = "INTERNAL_ERROR"

UploadErrorCode = Literal["ARTIFACT_UPLOAD_FAILED", "MANIFEST_UPLOAD_FAILED"]
ARTIFACT_UPLOAD_FAILED: Final[UploadErrorCode] = "ARTIFACT_UPLOAD_FAILED"


@dataclass(frozen=True, slots=True)
class SourceDownloadExpectation:
    """Immutable limits obtained from the winning claim."""

    size_bytes: int
    etag: str
    max_size_bytes: int


@dataclass(frozen=True, slots=True)
class ValidatedCapabilityPaths:
    """Object keys and endpoint paths validated before local processing."""

    result_keys: ResultArtifactKeys
    manifest_key: str


def _default_transport_factory(_hostname: str, _address: str) -> httpx.BaseTransport:
    return httpx.HTTPTransport(
        http1=True,
        http2=False,
        limits=httpx.Limits(
            max_connections=2,
            max_keepalive_connections=1,
            keepalive_expiry=30,
        ),
        retries=0,
        trust_env=False,
    )


class PinnedDnsTransport(httpx.BaseTransport):
    """Connect to a validated IP while preserving the signed Host and TLS SNI."""

    def __init__(
        self,
        policy: UrlPolicy,
        *,
        transport_factory: TransportFactory = _default_transport_factory,
    ) -> None:
        """Use isolated pools per original hostname and pinned address."""
        self._policy = policy
        self._transport_factory = transport_factory
        self._transports: dict[tuple[str, str], httpx.BaseTransport] = {}
        self._lock = Lock()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Validate every request and never reconnect through unvalidated DNS."""
        purpose_value = request.extensions.get(URL_PURPOSE_EXTENSION)
        try:
            purpose = UrlPurpose(cast("str", purpose_value))
            validated = self._policy.validate(str(request.url), purpose)
        except (TypeError, ValueError) as error:
            msg = "Request URL was rejected by policy"
            raise httpx.InvalidURL(msg) from error

        content = request.read()
        last_error: httpx.ConnectError | httpx.ConnectTimeout | None = None
        for address in validated.addresses:
            address_text = str(address)
            transport = self._transport(validated.hostname, address_text)
            pinned_request = self._pinned_request(
                request,
                validated,
                address_text,
                content,
            )
            try:
                return transport.handle_request(pinned_request)
            except (httpx.ConnectError, httpx.ConnectTimeout) as error:
                last_error = error
        if last_error is None:  # pragma: no cover - policy requires at least one address
            raise AssertionError
        raise last_error

    def close(self) -> None:
        """Close every host-isolated connection pool."""
        with self._lock:
            transports = tuple(self._transports.values())
            self._transports.clear()
        for transport in transports:
            transport.close()

    def _transport(self, hostname: str, address: str) -> httpx.BaseTransport:
        key = (hostname, address)
        with self._lock:
            transport = self._transports.get(key)
            if transport is None:
                transport = self._transport_factory(hostname, address)
                self._transports[key] = transport
            return transport

    @staticmethod
    def _pinned_request(
        request: httpx.Request,
        validated: ValidatedUrl,
        address: str,
        content: bytes,
    ) -> httpx.Request:
        headers = request.headers.copy()
        headers["host"] = validated.hostname
        extensions = dict(request.extensions)
        extensions.pop(URL_PURPOSE_EXTENSION, None)
        extensions["sni_hostname"] = validated.hostname
        return httpx.Request(
            method=request.method,
            url=request.url.copy_with(host=address),
            headers=headers,
            content=content,
            extensions=extensions,
        )


class CapabilityHttpClient:
    """HTTP operations scoped to claim-issued capabilities."""

    def __init__(
        self,
        policy: UrlPolicy,
        *,
        transport_factory: TransportFactory = _default_transport_factory,
    ) -> None:
        """Build a no-proxy, no-redirect client over the pinning transport."""
        self._policy = policy
        self._client = httpx.Client(
            follow_redirects=False,
            timeout=httpx.Timeout(
                connect=CONNECT_TIMEOUT_SECONDS,
                read=READ_TIMEOUT_SECONDS,
                write=WRITE_TIMEOUT_SECONDS,
                pool=CONNECT_TIMEOUT_SECONDS,
            ),
            transport=PinnedDnsTransport(policy, transport_factory=transport_factory),
            trust_env=False,
        )

    def close(self) -> None:
        """Release network connections."""
        self._client.close()

    def validate_claim_capabilities(
        self,
        claim: RunpodClaimGranted,
        *,
        job_id: str,
        attempt_id: str,
    ) -> ValidatedCapabilityPaths:
        """Resolve and validate every claim URL before creating task state."""
        source = self._policy.validate(claim.source.get_url, UrlPurpose.SOURCE)
        source_path = unquote(source.parsed.path)
        source_pattern = re.compile(
            rf"^/[a-z0-9][a-z0-9.-]{{1,62}}/incoming/[0-9a-f]{{32}}/"
            rf"{re.escape(job_id)}/[A-Za-z0-9_-]{{22}}/"
            r"source\.(?:flac|m4a|mov|mp3|mp4|ogg|opus|wav|webm)$"
        )
        if source_pattern.fullmatch(source_path) is None:
            msg = "Source capability path is invalid"
            raise ValueError(msg)

        heartbeat = self._policy.validate(claim.heartbeat.url, UrlPurpose.ORCHESTRATOR)
        if heartbeat.parsed.path != "/internal/runpod/heartbeat":
            msg = "Heartbeat capability path is invalid"
            raise ValueError(msg)

        result_urls = (
            claim.results.markdown_put_url,
            claim.results.json_put_url,
            claim.results.srt_put_url,
            claim.results.manifest_put_url,
        )
        for result_url in result_urls:
            self._policy.validate(result_url, UrlPurpose.RESULT)
        return ValidatedCapabilityPaths(
            result_keys=ResultArtifactKeys(
                markdown=extract_result_key(
                    claim.results.markdown_put_url,
                    job_id=job_id,
                    attempt_id=attempt_id,
                    filename="transcript.md",
                ),
                json_artifact=extract_result_key(
                    claim.results.json_put_url,
                    job_id=job_id,
                    attempt_id=attempt_id,
                    filename="transcript.json",
                ),
                srt=extract_result_key(
                    claim.results.srt_put_url,
                    job_id=job_id,
                    attempt_id=attempt_id,
                    filename="transcript.srt",
                ),
            ),
            manifest_key=extract_result_key(
                claim.results.manifest_put_url,
                job_id=job_id,
                attempt_id=attempt_id,
                filename="manifest.json",
            ),
        )

    def claim(self, url: str, request: RunpodClaimRequest) -> ClaimResponse:
        """Exchange the one-time claim token for winner capabilities."""
        try:
            body = self._post_control(
                url,
                request.model_dump(mode="json", by_alias=True),
                UrlPurpose.ORCHESTRATOR,
            )
            return CLAIM_RESPONSE_ADAPTER.validate_json(body)
        except (httpx.HTTPError, ValidationError, ValueError):
            raise WorkerError(CLAIM_REJECTED) from None

    def heartbeat(self, url: str, request: RunpodHeartbeatRequest) -> RunpodHeartbeatResponse:
        """Send winner liveness and obtain current cancellation state."""
        try:
            body = self._post_control(
                url,
                request.model_dump(mode="json", by_alias=True),
                UrlPurpose.ORCHESTRATOR,
            )
            return RunpodHeartbeatResponse.model_validate_json(body)
        except (httpx.HTTPError, ValidationError, ValueError):
            raise WorkerError(INTERNAL_ERROR) from None

    def download(
        self,
        url: str,
        destination: Path,
        *,
        expectation: SourceDownloadExpectation,
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """Stream one source object to disk while enforcing size and identity."""
        extensions = {URL_PURPOSE_EXTENSION: UrlPurpose.SOURCE.value}
        headers = {"accept-encoding": "identity"}
        try:
            with self._client.stream(
                "GET",
                url,
                headers=headers,
                extensions=extensions,
            ) as response:
                self._validate_download_response(response)
                self._validate_download_headers(
                    response,
                    expected_size_bytes=expectation.size_bytes,
                    expected_etag=expectation.etag,
                    max_size_bytes=expectation.max_size_bytes,
                )
                received = self._write_download(
                    response.iter_bytes(),
                    destination,
                    max_size_bytes=min(expectation.size_bytes, expectation.max_size_bytes),
                    on_chunk=on_chunk,
                )
        except WorkerError:
            raise
        except (OSError, httpx.HTTPError):
            raise WorkerError(SOURCE_DOWNLOAD_FAILED) from None
        if received != expectation.size_bytes:
            raise WorkerError(SOURCE_SIZE_MISMATCH)
        return received

    def put_artifact(self, url: str, content: bytes, content_type: str) -> None:
        """Write one exact result artifact."""
        self._put(url, content, content_type, "ARTIFACT_UPLOAD_FAILED")

    def put_file(
        self,
        url: str,
        content: BinaryIO,
        *,
        content_type: str,
        size_bytes: int,
        sha256: str,
    ) -> None:
        """Verify and stream one regular task-local artifact with fixed length."""
        try:
            _validate_streaming_artifact(content, size_bytes=size_bytes, sha256=sha256)
            self._put_stream(url, content, content_type, size_bytes)
        except WorkerError:
            raise
        except (OSError, ValueError):
            raise WorkerError(ARTIFACT_UPLOAD_FAILED) from None

    def put_manifest(self, url: str, content: bytes) -> None:
        """Write the manifest completion marker last."""
        self._put(url, content, "application/json", "MANIFEST_UPLOAD_FAILED")

    def _post_control(
        self,
        url: str,
        payload: dict[str, object],
        purpose: UrlPurpose,
    ) -> bytes:
        extensions = {URL_PURPOSE_EXTENSION: purpose.value}
        with self._client.stream(
            "POST",
            url,
            json=payload,
            extensions=extensions,
        ) as response:
            _validate_control_response(response)
            return _read_limited(response.iter_bytes(), MAX_CONTROL_RESPONSE_BYTES)

    @staticmethod
    def _validate_download_response(response: httpx.Response) -> None:
        if response.status_code != HTTP_OK:
            raise WorkerError(SOURCE_DOWNLOAD_FAILED)
        if response.headers.get("content-encoding", "identity").lower() != "identity":
            raise WorkerError(SOURCE_DOWNLOAD_FAILED)

    @staticmethod
    def _validate_download_headers(
        response: httpx.Response,
        *,
        expected_size_bytes: int,
        expected_etag: str,
        max_size_bytes: int,
    ) -> None:
        content_length = response.headers.get("content-length")
        if content_length is not None:
            if not content_length.isascii() or not content_length.isdecimal():
                raise WorkerError(SOURCE_DOWNLOAD_FAILED)
            declared_size = int(content_length)
            if declared_size > max_size_bytes or declared_size != expected_size_bytes:
                raise WorkerError(SOURCE_SIZE_MISMATCH)
        received_etag = response.headers.get("etag")
        if received_etag is None or _normalize_etag(received_etag) != _normalize_etag(
            expected_etag
        ):
            raise WorkerError(SOURCE_ETAG_MISMATCH)

    @staticmethod
    def _write_download(
        chunks: Iterable[bytes],
        destination: Path,
        *,
        max_size_bytes: int,
        on_chunk: Callable[[], None] | None,
    ) -> int:
        received = 0
        with destination.open("xb") as output:
            for chunk in chunks:
                received += len(chunk)
                if received > max_size_bytes:
                    raise WorkerError(SOURCE_SIZE_MISMATCH)
                output.write(chunk)
                if on_chunk is not None:
                    on_chunk()
        return received

    def _put(
        self,
        url: str,
        content: bytes,
        content_type: str,
        error_code: UploadErrorCode,
    ) -> None:
        extensions = {URL_PURPOSE_EXTENSION: UrlPurpose.RESULT.value}
        try:
            with self._client.stream(
                "PUT",
                url,
                content=content,
                headers={"cache-control": "no-store", "content-type": content_type},
                extensions=extensions,
            ) as response:
                _validate_put_response(response, error_code)
                _read_limited(response.iter_bytes(), MAX_CONTROL_RESPONSE_BYTES)
        except WorkerError:
            raise
        except (OSError, httpx.HTTPError, ValueError):
            raise WorkerError(error_code) from None

    def _put_stream(
        self,
        url: str,
        content: BinaryIO,
        content_type: str,
        size_bytes: int,
    ) -> None:
        extensions = {URL_PURPOSE_EXTENSION: UrlPurpose.RESULT.value}

        def chunks() -> Iterable[bytes]:
            remaining = size_bytes
            while remaining > 0:
                chunk = content.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise WorkerError(ARTIFACT_UPLOAD_FAILED)
                remaining -= len(chunk)
                yield chunk
            if content.read(1):
                raise WorkerError(ARTIFACT_UPLOAD_FAILED)

        try:
            with self._client.stream(
                "PUT",
                url,
                content=chunks(),
                headers={
                    "cache-control": "no-store",
                    "content-length": str(size_bytes),
                    "content-type": content_type,
                },
                extensions=extensions,
            ) as response:
                _validate_put_response(response, ARTIFACT_UPLOAD_FAILED)
                _read_limited(response.iter_bytes(), MAX_CONTROL_RESPONSE_BYTES)
        except WorkerError:
            raise
        except (OSError, httpx.HTTPError, ValueError):
            raise WorkerError(ARTIFACT_UPLOAD_FAILED) from None


def _validate_streaming_artifact(
    content: BinaryIO,
    *,
    size_bytes: int,
    sha256: str,
) -> None:
    """Verify a regular descriptor and its declared integrity before upload."""
    descriptor = content.fileno()
    file_info = os.fstat(descriptor)
    if not stat.S_ISREG(file_info.st_mode) or file_info.st_size != size_bytes:
        raise WorkerError(ARTIFACT_UPLOAD_FAILED)
    digest = hashlib.sha256()
    content.seek(0)
    while chunk := content.read(1024 * 1024):
        digest.update(chunk)
    if digest.hexdigest() != sha256:
        raise WorkerError(ARTIFACT_UPLOAD_FAILED)
    content.seek(0)


def _read_limited(chunks: Iterable[bytes], limit: int) -> bytes:
    body = bytearray()
    for chunk in chunks:
        body.extend(chunk)
        if len(body) > limit:
            msg = "HTTP response exceeded the limit"
            raise ValueError(msg)
    return bytes(body)


def _validate_control_response(response: httpx.Response) -> None:
    if response.status_code != HTTP_OK:
        msg = "Control request failed"
        raise ValueError(msg)
    content_type = response.headers.get("content-type", "").lower()
    if not content_type.startswith("application/json"):
        msg = "Control response was not JSON"
        raise ValueError(msg)


def _validate_put_response(response: httpx.Response, error_code: UploadErrorCode) -> None:
    if response.status_code < HTTP_OK or response.status_code >= HTTP_REDIRECT_START:
        raise WorkerError(error_code)


def _normalize_etag(value: str) -> str:
    normalized = value.strip()
    if (
        normalized.startswith('"')
        and normalized.endswith('"')
        and len(normalized) >= ETAG_QUOTE_PAIR_LENGTH
    ):
        return normalized[1:-1]
    return normalized
