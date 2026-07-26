"""Security and product limits shared by the RunPod worker."""

from typing import Final

SCHEMA_VERSION: Final = 1
MAX_SOURCE_BYTES: Final = 2 * 1024 * 1024 * 1024
MAX_DURATION_SECONDS: Final = 8 * 60 * 60
MAX_STREAMS: Final = 32
MAX_URL_LENGTH: Final = 8 * 1024
MODEL_NAME: Final = "large-v3-turbo"
DEFAULT_MODEL_PATH: Final = "/opt/models/large-v3-turbo"
