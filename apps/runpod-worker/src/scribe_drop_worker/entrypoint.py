"""RunPod Serverless process entrypoint."""

from __future__ import annotations

import importlib
import os
from typing import Protocol, cast

from .config import load_settings
from .handler import create_handler
from .logger import WorkerLogger
from .service import build_default_service


class ServerlessPort(Protocol):
    """Subset of the RunPod SDK used at process startup."""

    def start(self, configuration: dict[str, object]) -> None:
        """Start the synchronous job loop."""


def main() -> None:
    """Validate configuration and start the official RunPod job loop."""
    settings = load_settings(os.environ)
    logger = WorkerLogger(environment=settings.app_environment)
    handler = create_handler(
        runtime_factory=lambda: build_default_service(settings, logger),
        logger=logger,
    )
    runpod_module = importlib.import_module("runpod")
    serverless = cast("ServerlessPort", runpod_module.serverless)
    serverless.start({"handler": handler, "refresh_worker": True})


if __name__ == "__main__":
    main()
