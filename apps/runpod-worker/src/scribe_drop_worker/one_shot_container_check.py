"""Network-free image gate for the Cloud Run one-shot runtime."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Final

from .bounded_container_check import check_bounded_container_core
from .one_shot import (
    create_runtime_key_pair,
    frame_runtime_challenge,
    load_one_shot_environment,
    require_exact_cuda_device,
)

ONE_SHOT_CONTAINER_CHECK_OK: Final = "cloud-run-one-shot-container-check:ok\n"
EXPECTED_UID: Final = 10001
EXPECTED_PUBLIC_KEY_LENGTH: Final = 43
EXPECTED_SIGNATURE_LENGTH: Final = 86


def _environment() -> dict[str, str]:
    return {
        "APP_ENV": "staging",
        "CLOUD_RUN_EXECUTION": "sd-stg-container-check-1",
        "CLOUD_RUN_JOB": "sd-stg-container-check",
        "CLOUD_RUN_TASK_ATTEMPT": "0",
        "CLOUD_RUN_TASK_COUNT": "1",
        "CLOUD_RUN_TASK_INDEX": "0",
        "MODEL_PATH": "/opt/models/large-v3-turbo",
        "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        "SCRIBE_DROP_EXECUTION_HANDLE": "h" * 43,
        "SCRIBE_DROP_EXECUTION_POLICY": "cloud_run_jobs_l4_v1",
        "SCRIBE_DROP_IDENTITY_AUDIENCE": (
            "https://orchestrator.example.invalid/internal/cloud-run/bootstrap"
        ),
        "SCRIBE_DROP_ORCHESTRATOR_ORIGIN": "https://orchestrator.example.invalid",
        "SCRIBE_DROP_RESULT_HOST": "storage.example.invalid",
        "SCRIBE_DROP_SOURCE_HOST": "storage.example.invalid",
    }


def _effective_uid() -> int:
    return os.geteuid()


def _model_present() -> bool:
    return Path("/opt/models/large-v3-turbo").is_dir()


def main() -> None:
    """Exercise identity framing, exact-GPU guard, bounded core, and non-root image state."""
    if _effective_uid() != EXPECTED_UID or not _model_present():
        msg = "one-shot image identity invariant failed"
        raise RuntimeError(msg)
    load_one_shot_environment(_environment())
    require_exact_cuda_device(lambda: 1)
    key_pair = create_runtime_key_pair()
    signature = key_pair.sign(frame_runtime_challenge(("container-check", "fixed")))
    if (
        len(key_pair.public_key) != EXPECTED_PUBLIC_KEY_LENGTH
        or len(signature) != EXPECTED_SIGNATURE_LENGTH
    ):
        msg = "one-shot key invariant failed"
        raise RuntimeError(msg)
    check_bounded_container_core()
    sys.stdout.write(ONE_SHOT_CONTAINER_CHECK_OK)


if __name__ == "__main__":
    main()
