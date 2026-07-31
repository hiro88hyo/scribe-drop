"""RunPod SDK handler boundary with unconditional worker refresh."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, Protocol

from pydantic import ValidationError

from .contracts import RunpodJobEnvelope, WorkerFailedOutput

if TYPE_CHECKING:
    from collections.abc import Callable

    from .logger import WorkerLogger
    from .service import WorkerOutput

REFRESH_WORKER_KEY: Final = "refresh_worker"


class WorkerServicePort(Protocol):
    """Lifecycle used by the handler."""

    def run(self, envelope: RunpodJobEnvelope) -> WorkerOutput:
        """Process one validated envelope."""

    def close(self) -> None:
        """Release resources before refresh."""


def create_handler(
    *,
    runtime_factory: Callable[[], WorkerServicePort],
    logger: WorkerLogger,
) -> Callable[[object], dict[str, object]]:
    """Create a synchronous RunPod handler with injected runtime construction."""

    def handler(raw_job: object) -> dict[str, object]:
        try:
            envelope = RunpodJobEnvelope.model_validate(raw_job)
        except ValidationError:
            logger.emit(
                "error",
                "worker_failed",
                {"status": "failed", "errorCode": "INTERNAL_ERROR"},
            )
            return {
                REFRESH_WORKER_KEY: True,
                "schemaVersion": 1,
                "status": "failed",
                "errorCode": "INTERNAL_ERROR",
                "manifestWritten": False,
            }

        runtime: WorkerServicePort | None = None
        try:
            runtime = runtime_factory()
            output = runtime.run(envelope)
        except Exception:  # noqa: BLE001 - final SDK boundary exposes no exception detail.
            output = WorkerFailedOutput(
                schemaVersion=1,
                jobId=envelope.input.job_id,
                attemptId=envelope.input.attempt_id,
                status="failed",
                errorCode="INTERNAL_ERROR",
                manifestWritten=False,
            )
        finally:
            if runtime is not None:
                try:
                    runtime.close()
                except Exception:  # noqa: BLE001 - refresh still required after close failure.
                    output = WorkerFailedOutput(
                        schemaVersion=1,
                        jobId=envelope.input.job_id,
                        attemptId=envelope.input.attempt_id,
                        status="failed",
                        errorCode="INTERNAL_ERROR",
                        manifestWritten=False,
                    )
        return {
            REFRESH_WORKER_KEY: True,
            **output.model_dump(mode="json", by_alias=True),
        }

    return handler
