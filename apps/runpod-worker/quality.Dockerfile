# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# This local-only quality image must be derived from the worker image built in the same run.
ARG WORKER_IMAGE=scribe-drop-runpod-worker:local
FROM ${WORKER_IMAGE} AS quality

USER 0:0

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        espeak-ng=1.51+dfsg-12build1 \
    && rm -rf /var/lib/apt/lists/*

LABEL io.scribedrop.image.purpose="local-bounded-quality-check" \
    io.scribedrop.espeak-ng.version="1.51+dfsg-12build1"

USER 10001:10001

ENTRYPOINT ["python", "-m", "scribe_drop_worker.bounded_quality_check"]
