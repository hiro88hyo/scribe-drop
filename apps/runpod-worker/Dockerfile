# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# ghcr.io/astral-sh/uv:0.11.32, linux/amd64 manifest
FROM --platform=linux/amd64 ghcr.io/astral-sh/uv@sha256:0d127b3a7049b879a6e18a79c7f33fea59aa83c226464248f89cfb716a6b96f5 AS uv

# nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04, linux/amd64 manifest
FROM --platform=linux/amd64 nvidia/cuda@sha256:9175fa92f96de35a8cfb9493f0dfcf9435c7a597e9d95ad41d2cae382a95e3f9 AS builder

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

RUN rm -f /etc/apt/sources.list.d/cuda.list \
    && sed -i \
        's|http://archive.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20260725T000000Z/|; s|http://security.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20260725T000000Z/|' \
        /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates=20260601~24.04.1 \
        dirmngr=2.4.4-2ubuntu17.4 \
        gnupg=2.4.4-2ubuntu17.4 \
        gnupg-utils=2.4.4-2ubuntu17.4 \
        gnupg2=2.4.4-2ubuntu17.4 \
        gpg=2.4.4-2ubuntu17.4 \
        gpg-agent=2.4.4-2ubuntu17.4 \
        gpgconf=2.4.4-2ubuntu17.4 \
        gpgsm=2.4.4-2ubuntu17.4 \
        gpgv=2.4.4-2ubuntu17.4 \
        keyboxd=2.4.4-2ubuntu17.4 \
        libssl3t64=3.0.13-0ubuntu3.11 \
        openssl=3.0.13-0ubuntu3.11 \
        python3.12=3.12.3-1ubuntu0.15 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app

COPY apps/runpod-worker/pyproject.toml apps/runpod-worker/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --python /usr/bin/python3.12

# Keep the 1.6 GiB immutable model layer independent from ordinary worker source changes.
COPY apps/runpod-worker/src/scribe_drop_worker/__init__.py \
    apps/runpod-worker/src/scribe_drop_worker/constants.py \
    apps/runpod-worker/src/scribe_drop_worker/model_bundle.py \
    ./src/scribe_drop_worker/
ENV HF_HUB_DISABLE_PROGRESS_BARS=1 \
    PYTHONPATH=/app/src
RUN /app/.venv/bin/python -m scribe_drop_worker.model_bundle /opt/models/large-v3-turbo \
    && chmod -R a-w /opt/models/large-v3-turbo

COPY apps/runpod-worker/src ./src

# nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04, linux/amd64 manifest
FROM --platform=linux/amd64 nvidia/cuda@sha256:9175fa92f96de35a8cfb9493f0dfcf9435c7a597e9d95ad41d2cae382a95e3f9 AS runtime

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list.d/cuda.list \
    && sed -i \
        's|http://archive.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20260725T000000Z/|; s|http://security.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20260725T000000Z/|' \
        /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates=20260601~24.04.1 \
        dirmngr=2.4.4-2ubuntu17.4 \
        ffmpeg=7:6.1.1-3ubuntu5 \
        gnupg=2.4.4-2ubuntu17.4 \
        gnupg-utils=2.4.4-2ubuntu17.4 \
        gnupg2=2.4.4-2ubuntu17.4 \
        gpg=2.4.4-2ubuntu17.4 \
        gpg-agent=2.4.4-2ubuntu17.4 \
        gpgconf=2.4.4-2ubuntu17.4 \
        gpgsm=2.4.4-2ubuntu17.4 \
        gpgv=2.4.4-2ubuntu17.4 \
        keyboxd=2.4.4-2ubuntu17.4 \
        libssl3t64=3.0.13-0ubuntu3.11 \
        openssl=3.0.13-0ubuntu3.11 \
        python3.12=3.12.3-1ubuntu0.15 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src
COPY --from=builder /opt/models/large-v3-turbo /opt/models/large-v3-turbo

ENV APP_ENV=production \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    HOME=/nonexistent \
    MODEL_PATH=/opt/models/large-v3-turbo \
    PATH=/app/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    TRANSFORMERS_OFFLINE=1 \
    XDG_CACHE_HOME=/tmp/.cache

LABEL org.opencontainers.image.title="ScribeDrop RunPod Worker" \
    org.opencontainers.image.base.name="nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04" \
    org.opencontainers.image.base.digest="sha256:9175fa92f96de35a8cfb9493f0dfcf9435c7a597e9d95ad41d2cae382a95e3f9" \
    io.scribedrop.cuda.version="12.8.1" \
    io.scribedrop.cudnn.variant="runtime-ubuntu24.04" \
    io.scribedrop.ffmpeg.package="7:6.1.1-3ubuntu5" \
    io.scribedrop.model.repository="dropbox-dash/faster-whisper-large-v3-turbo" \
    io.scribedrop.model.revision="0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf" \
    io.scribedrop.model.sha256="e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da" \
    io.scribedrop.python.version="3.12" \
    io.scribedrop.runpod.version="1.11.0" \
    io.scribedrop.uv.version="0.11.32"

USER 10001:10001

ENTRYPOINT ["python", "-m", "scribe_drop_worker.entrypoint"]
