"""GPU-free staging preflight for the Cloud Run bootstrap authentication path."""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING, Final, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from .cloud_run_contracts import BootstrapRequest, RuntimeIdentity
from .cloud_run_errors import BOOTSTRAP_REJECTED, OneShotRuntimeError
from .cloud_run_http import MetadataIdentityClient
from .http_client import (
    CONNECT_TIMEOUT_SECONDS,
    MAX_CONTROL_RESPONSE_BYTES,
    READ_TIMEOUT_SECONDS,
    URL_PURPOSE_EXTENSION,
    WRITE_TIMEOUT_SECONDS,
    PinnedDnsTransport,
)
from .one_shot import (
    IdentityTokenPort,
    OneShotEnvironment,
    create_runtime_key_pair,
    load_one_shot_environment,
)
from .url_policy import UrlPolicy, UrlPurpose

if TYPE_CHECKING:
    from collections.abc import Mapping

PREFLIGHT_OK: Final = "cloud-run-staging-bootstrap-preflight:ok:RESOURCE_DRIFT\n"
PREFLIGHT_FAILED: Final = "cloud-run-staging-bootstrap-preflight:failed\n"
HTTP_FORBIDDEN: Final = 403


class _RuntimeErrorBody(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    code: Literal["RESOURCE_DRIFT"]
    message: Literal["Runtime request was rejected."]


class _RuntimeErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    error: _RuntimeErrorBody


def run_staging_bootstrap_preflight(
    settings: OneShotEnvironment,
    *,
    identity: IdentityTokenPort,
    transport: httpx.BaseTransport,
) -> None:
    """Prove edge reachability and Google OIDC before any GPU/data side effect."""
    if settings.environment != "staging":
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED)
    key_pair = create_runtime_key_pair()
    runtime_identity = RuntimeIdentity(
        bootstrapRequestId=settings.bootstrap_request_id,
        environment=settings.environment,
        executionHandle=settings.execution_handle,
        executionName=settings.execution_name,
        jobName=settings.job_name,
        policyId=settings.execution_policy,
        publicKey=key_pair.public_key,
        taskAttempt=0,
        taskCount=1,
        taskIndex=0,
    )
    request = BootstrapRequest(
        **runtime_identity.model_dump(by_alias=True),
        identityToken=identity.token(settings.identity_audience),
    )
    try:
        with (
            httpx.Client(
                follow_redirects=False,
                timeout=httpx.Timeout(
                    connect=CONNECT_TIMEOUT_SECONDS,
                    read=READ_TIMEOUT_SECONDS,
                    write=WRITE_TIMEOUT_SECONDS,
                    pool=CONNECT_TIMEOUT_SECONDS,
                ),
                transport=transport,
                trust_env=False,
            ) as client,
            client.stream(
                "POST",
                settings.identity_audience,
                json=request.model_dump(mode="json", by_alias=True),
                extensions={URL_PURPOSE_EXTENSION: UrlPurpose.ORCHESTRATOR.value},
            ) as response,
        ):
            _validate_response(response)
    except (httpx.HTTPError, ValidationError, UnicodeError, ValueError):
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED) from None


def _create_transport(settings: OneShotEnvironment) -> PinnedDnsTransport:
    orchestrator_host = urlsplit(settings.orchestrator_origin).hostname
    if orchestrator_host is None:
        raise OneShotRuntimeError(BOOTSTRAP_REJECTED)
    return PinnedDnsTransport(
        UrlPolicy(
            orchestrator_host=orchestrator_host,
            source_hosts=frozenset({settings.source_host}),
            result_hosts=frozenset({settings.result_host}),
        )
    )


def _read_bounded(response: httpx.Response, limit: int) -> bytes:
    body = bytearray()
    for chunk in response.iter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            message = "staging bootstrap preflight response exceeded limit"
            raise ValueError(message)
    return bytes(body)


def _validate_response(response: httpx.Response) -> None:
    if response.status_code != HTTP_FORBIDDEN or not response.headers.get(
        "content-type", ""
    ).lower().startswith("application/json"):
        message = "staging bootstrap preflight response rejected"
        raise ValueError(message)
    body = _read_bounded(response, MAX_CONTROL_RESPONSE_BYTES)
    _RuntimeErrorEnvelope.model_validate_json(body)


def main(environment: Mapping[str, str] | None = None) -> None:
    """Emit one allowlisted marker without leaking identity or response material."""
    identity: MetadataIdentityClient | None = None
    try:
        settings = load_one_shot_environment(os.environ if environment is None else environment)
        identity = MetadataIdentityClient()
        run_staging_bootstrap_preflight(
            settings,
            identity=identity,
            transport=_create_transport(settings),
        )
    except Exception:  # noqa: BLE001 - process boundary emits a fixed marker only.
        sys.stderr.write(PREFLIGHT_FAILED)
        raise SystemExit(1) from None
    finally:
        if identity is not None:
            identity.close()
    sys.stdout.write(PREFLIGHT_OK)


if __name__ == "__main__":
    main()
