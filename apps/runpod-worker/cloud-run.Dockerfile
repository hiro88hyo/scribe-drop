# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG WORKER_IMAGE=scribe-drop-runpod-worker:local
FROM ${WORKER_IMAGE}

LABEL org.opencontainers.image.title="ScribeDrop Cloud Run One-Shot Worker" \
    io.scribedrop.execution.policy="cloud_run_jobs_l4_v1" \
    io.scribedrop.execution.contract="2"

ENTRYPOINT ["python", "-m", "scribe_drop_worker.one_shot"]
